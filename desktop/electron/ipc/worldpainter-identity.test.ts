import { expect, it, vi } from 'vitest';
const calls=vi.hoisted(()=>({get:vi.fn(),spawn:vi.fn(),quit:vi.fn()}));
vi.mock('electron',()=>({app:{getVersion:()=> '0.1.0',quit:calls.quit}}));
vi.mock('axios',()=>({default:{get:calls.get}}));
vi.mock('child_process',()=>({spawn:calls.spawn}));
vi.mock('./store',()=>({readStore:()=>({settings:{}})}));
vi.mock('./proxy',()=>({proxyConfig:()=>({})}));
import {checkUpdate} from './update';
import {downloadUpdate,installUpdate,planAppUpdate} from './auto-update';
import {LEGACY_USER_DATA_DIRS,STABLE_USER_DATA_DIR,STORE_FILE_NAME} from '../user-data-migration';
it('has an isolated identity and never auto-imports upstream credentials',()=>{
  expect(LEGACY_USER_DATA_DIRS).toEqual([]);
  expect(STABLE_USER_DATA_DIR).toBe('NAI-WorldPainter-PC');
  expect(STORE_FILE_NAME).toBe('worldpainter-desktop.json');
});
it('preview builds cannot check, download or execute an upstream installer',async()=>{
  expect(await checkUpdate()).toMatchObject({hasUpdate:false});
  expect(await downloadUpdate()).toMatchObject({ok:false});
  await expect(planAppUpdate()).rejects.toThrow('尚未配置正式更新渠道');
  await expect(installUpdate()).rejects.toThrow('尚未配置正式更新渠道');
  expect(calls.get).not.toHaveBeenCalled();
  expect(calls.spawn).not.toHaveBeenCalled();
  expect(calls.quit).not.toHaveBeenCalled();
});
