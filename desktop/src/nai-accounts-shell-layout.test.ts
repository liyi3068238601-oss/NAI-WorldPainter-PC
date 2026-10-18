import {readFileSync} from 'node:fs';
import ts from 'typescript';
import {describe,it,expect} from 'vitest';

describe('account selector preserves the application grid',()=>{
 it('nests the selector inside the existing toolbar rather than adding a grid row',()=>{
  const source=ts.createSourceFile('App.tsx',readFileSync('src/App.tsx','utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
  let shell:ts.JsxElement|undefined;
  function walk(node:ts.Node){if(ts.isJsxElement(node)&&node.openingElement.attributes.properties.some(p=>ts.isJsxAttribute(p)&&p.name.getText(source)==='className'&&p.initializer?.getText(source)==='"app-shell"'))shell=node;ts.forEachChild(node,walk);}
  walk(source);expect(shell).toBeDefined();
  const children=shell!.children.filter(n=>ts.isJsxElement(n)||ts.isJsxSelfClosingElement(n));
  const tag=(node:ts.JsxElement|ts.JsxSelfClosingElement)=>ts.isJsxElement(node)?node.openingElement.tagName.getText(source):node.tagName.getText(source);
  expect(children.map(tag)).not.toContain('NaiAccountManager');
  const toolbar=children.find(n=>tag(n)==='AppMenuBar');expect(toolbar&&ts.isJsxElement(toolbar)).toBe(true);
  expect(toolbar!.getText(source)).toContain('<NaiAccountManager />');
  const chrome=readFileSync('src/app/AppChrome.tsx','utf8');expect(chrome).toContain('children?: ReactNode');expect(chrome).toContain('{children}');
 });

 it('compacts the shared chrome only on Agent while keeping scaled controls reachable',()=>{
  const app=readFileSync('src/App.tsx','utf8');
  expect(app).toContain('data-agent-chrome-compact={activeTab === "agent" ? "true" : undefined}');
  const css=readFileSync('src/app/agent-compact-chrome.css','utf8');
  const selectors=[...css.replace(/\/\*[\s\S]*?\*\//g,'').matchAll(/([^{}]+)\{[^{}]*\}/g)].map(match=>match[1].trim());
  expect(selectors.length).toBeGreaterThan(0);
  for(const selector of selectors) expect(selector.startsWith('html .app-shell[data-agent-chrome-compact="true"]')).toBe(true);
  // Compaction must not shrink users' chosen text or make existing controls
  // unreachable. Native geometry evidence checks the actual resulting sizes.
  expect(css).not.toMatch(/font-size\s*:|display\s*:\s*none|visibility\s*:\s*hidden|pointer-events\s*:\s*none/);

  const main=readFileSync('src/main.tsx','utf8');
  expect(main.indexOf('import "./app/agent-compact-chrome.css"')).toBeGreaterThan(main.indexOf('import "./typography.css"'));
  const chrome=readFileSync('src/app/AppChrome.tsx','utf8');
  for(const entry of ['stream-preview-toggle','chromeText.outputDir','chromeText.settings','chromeText.docs']) expect(chrome).toContain(entry);
  const navigation=readFileSync('src/app/AppTabBar.tsx','utf8');
  expect(navigation).toContain('tab-overflow-control');
  expect(navigation).toContain('tab-arrange-toggle');
 });
});
