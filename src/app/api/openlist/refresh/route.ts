/* eslint-disable @typescript-eslint/no-explicit-any, no-console */

import { NextRequest, NextResponse } from 'next/server';

import { getAuthInfoFromCookie } from '@/lib/auth';
import { getConfig } from '@/lib/config';
import { db } from '@/lib/db';
import { OpenListClient } from '@/lib/openlist.client';
import {
  getCachedMetaInfo,
  invalidateMetaInfoCache,
  MetaInfo,
  setCachedMetaInfo,
} from '@/lib/openlist-cache';
import {
  cleanupOldTasks,
  completeScanTask,
  createScanTask,
  failScanTask,
  updateScanTaskProgress,
} from '@/lib/scan-task';
import { searchTMDB } from '@/lib/tmdb.search';

export const runtime = 'nodejs';

/**
 * POST /api/openlist/refresh
 * 刷新私人影库元数据（后台任务模式）
 */
export async function POST(request: NextRequest) {
  try {
    // 权限检查
    const authInfo = getAuthInfoFromCookie(request);
    if (!authInfo || !authInfo.username) {
      return NextResponse.json({ error: '未授权' }, { status: 401 });
    }

    // 获取配置
    const config = await getConfig();
    const openListConfig = config.OpenListConfig;

    if (!openListConfig || !openListConfig.URL || !openListConfig.Username || !openListConfig.Password) {
      return NextResponse.json(
        { error: 'OpenList 未配置' },
        { status: 400 }
      );
    }

    const tmdbApiKey = config.SiteConfig.TMDBApiKey;
    const tmdbProxy = config.SiteConfig.TMDBProxy;

    if (!tmdbApiKey) {
      return NextResponse.json(
        { error: 'TMDB API Key 未配置' },
        { status: 400 }
      );
    }

    // 清理旧任务
    cleanupOldTasks();

    // 创建后台任务
    const taskId = createScanTask();

    // 启动后台扫描
    performScan(
      taskId,
      openListConfig.URL,
      openListConfig.RootPath || '/',
      tmdbApiKey,
      tmdbProxy,
      openListConfig.Username,
      openListConfig.Password
    ).catch((error) => {
      console.error('[OpenList Refresh] 后台扫描失败:', error);
      failScanTask(taskId, (error as Error).message);
    });

    return NextResponse.json({
      success: true,
      taskId,
      message: '扫描任务已启动',
    });
  } catch (error) {
    console.error('启动刷新任务失败:', error);
    return NextResponse.json(
      { error: '启动失败', details: (error as Error).message },
      { status: 500 }
    );
  }
}

/**
 * 执行扫描任务
 */
async function performScan(
  taskId: string,
  url: string,
  rootPath: string,
  tmdbApiKey: string,
  tmdbProxy?: string,
  username?: string,
  password?: string
): Promise<void> {
  const client = new OpenListClient(url, username!, password!);

  // 立即清除缓存，确保后续读取的是新数据
  invalidateMetaInfoCache(rootPath);

  // 立即更新进度，确保任务可被查询
  updateScanTaskProgress(taskId, 0, 0);

  try {
    // 1. 不读取现有数据，直接创建新的 metainfo
    const metaInfo: MetaInfo = {
      folders: {},
      last_refresh: Date.now(),
    };

    // 2. 列出根目录下的所有文件夹（强制刷新 OpenList 缓存）
    // 循环获取所有页的数据
    const folders: any[] = [];
    let currentPage = 1;
    const pageSize = 100;
    let total = 0;

    while (true) {
      const listResponse = await client.listDirectory(rootPath, currentPage, pageSize, true);

      if (listResponse.code !== 200) {
        throw new Error('OpenList 列表获取失败');
      }

      total = listResponse.data.total;
      const pageFolders = listResponse.data.content.filter((item) => item.is_dir);
      folders.push(...pageFolders);

      // 如果已经获取了所有数据，退出循环
      if (folders.length >= total) {
        break;
      }

      currentPage++;
    }

    // 更新任务进度
    updateScanTaskProgress(taskId, 0, folders.length);

    // 3. 遍历文件夹，搜索 TMDB
    let newCount = 0;
    let errorCount = 0;

    for (let i = 0; i < folders.length; i++) {
      const folder = folders[i];

      // 更新进度
      updateScanTaskProgress(taskId, i + 1, folders.length, folder.name);

      try {
        // 搜索 TMDB
        const searchResult = await searchTMDB(
          tmdbApiKey,
          folder.name,
          tmdbProxy
        );

        if (searchResult.code === 200 && searchResult.result) {
          const result = searchResult.result;

          metaInfo.folders[folder.name] = {
            tmdb_id: result.id,
            title: result.title || result.name || folder.name,
            poster_path: result.poster_path,
            release_date: result.release_date || result.first_air_date || '',
            overview: result.overview,
            vote_average: result.vote_average,
            media_type: result.media_type,
            last_updated: Date.now(),
            failed: false,
          };

          newCount++;
        } else {
          // 记录失败的文件夹
          metaInfo.folders[folder.name] = {
            tmdb_id: 0,
            title: folder.name,
            poster_path: null,
            release_date: '',
            overview: '',
            vote_average: 0,
            media_type: 'movie',
            last_updated: Date.now(),
            failed: true,
          };
          errorCount++;
        }

        // 避免请求过快
        await new Promise((resolve) => setTimeout(resolve, 300));
      } catch (error) {
        console.error(`[OpenList Refresh] 处理文件夹失败: ${folder.name}`, error);
        // 记录失败的文件夹
        metaInfo.folders[folder.name] = {
          tmdb_id: 0,
          title: folder.name,
          poster_path: null,
          release_date: '',
          overview: '',
          vote_average: 0,
          media_type: 'movie',
          last_updated: Date.now(),
          failed: true,
        };
        errorCount++;
      }
    }

    // 4. 保存 metainfo 到数据库
    metaInfo.last_refresh = Date.now();

    const metainfoContent = JSON.stringify(metaInfo);
    await db.setGlobalValue('video.metainfo', metainfoContent);

    // 5. 更新缓存
    invalidateMetaInfoCache(rootPath);
    setCachedMetaInfo(rootPath, metaInfo);

    // 6. 更新配置
    const config = await getConfig();
    config.OpenListConfig!.LastRefreshTime = Date.now();
    config.OpenListConfig!.ResourceCount = Object.keys(metaInfo.folders).length;
    await db.saveAdminConfig(config);

    // 完成任务
    completeScanTask(taskId, {
      total: folders.length,
      new: newCount,
      existing: 0,
      errors: errorCount,
    });
  } catch (error) {
    console.error('[OpenList Refresh] 扫描失败:', error);
    failScanTask(taskId, (error as Error).message);
    throw error;
  }
}
