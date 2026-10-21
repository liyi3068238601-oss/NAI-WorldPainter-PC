import { describe, expect, it } from 'vitest';
import { migrateLegacyNaiAccount } from './nai-accounts-migration';
import { NaiAccountsVault, type AccountVaultDocument } from './nai-accounts-vault';

const cipher={isEncryptionAvailable:()=>true,encryptString:(value:string)=>Buffer.from(`sealed:${value}`),decryptString:(value:Buffer)=>value.toString().replace(/^sealed:/,'')};
const settings=(allowCustomEndpoint:boolean)=>({apiBaseUrl:'https://api.novelai.net',imageBaseUrl:'http://images.relay.example:8765/custom',allowCustomEndpoint,allowCustomEndpointFallback:false});

describe('legacy custom HTTP endpoint migration',()=>{
 it('migrates an opted-in image relay and preserves it across vault reopen and backup export',()=>{
  let document:AccountVaultDocument={version:1,accounts:[]};
  const vault=new NaiAccountsVault(document,cipher,next=>{document=structuredClone(next);});
  const result=migrateLegacyNaiAccount(vault,{token:'legacy-fixture-token',settings:settings(true)});
  expect(result.migrated).toBe(true);
  expect(result.account).toMatchObject({method:'token',apiBaseUrl:'https://api.novelai.net',imageBaseUrl:'http://images.relay.example:8765/custom'});
  const reopened=new NaiAccountsVault(structuredClone(document),cipher,()=>{});
  const lease=reopened.bind(result.account!.id);
  expect(lease.snapshot.imageBaseUrl).toBe('http://images.relay.example:8765/custom');
  expect(reopened.exportBackup().accounts[0]).toMatchObject({
   apiBaseUrl:'https://api.novelai.net',imageBaseUrl:'http://images.relay.example:8765/custom',
   legacyConfiguration:{allowCustomEndpoint:true,allowCustomEndpointFallback:false},
  });
  lease.release();
 });

 it('does not migrate remote HTTP without the legacy custom-endpoint opt-in',()=>{
  const vault=new NaiAccountsVault({version:1,accounts:[]},cipher,()=>{});
  expect(()=>migrateLegacyNaiAccount(vault,{token:'legacy-fixture-token',settings:settings(false)})).toThrow(/协议不受支持/);
  expect(vault.legacyMigrated()).toBe(false);
 });

 it('never permits an official NovelAI host over HTTP, even with custom endpoints enabled',()=>{
  const vault=new NaiAccountsVault({version:1,accounts:[]},cipher,()=>{});
  expect(()=>migrateLegacyNaiAccount(vault,{token:'legacy-fixture-token',settings:{...settings(true),imageBaseUrl:'http://image.novelai.net'}})).toThrow(/协议不受支持/);
  expect(vault.legacyMigrated()).toBe(false);
 });
});
