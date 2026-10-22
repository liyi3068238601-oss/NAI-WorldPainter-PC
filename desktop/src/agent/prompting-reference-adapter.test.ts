import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {describe,it,expect} from 'vitest';
import {adaptPromptingReference} from './prompting-reference-adapter';

const referencePath=(name:'ideation'|'writing')=>path.resolve('public/worldpainter/mobile/nai5-prompting/references',
  name==='ideation'?'通用构思.md':'通用写法.md');

describe('PC prompting reference adapter',()=>{
  it('adapts ideation guidance while retaining its concrete storyboarding techniques',()=>{
    const source=readFileSync(referencePath('ideation'),'utf8');
    const sourceHash=createHash('sha256').update(source).digest('hex');
    const adapted=adaptPromptingReference('ideation',source);
    expect(adapted).toContain('read_prompting_reference');
    expect(adapted).toContain('近景人物可以只露局部');
    expect(adapted).toContain('先定空间，再放人');
    expect(adapted.length).toBeGreaterThan(source.length*0.7);
    expect(adapted).not.toContain('首答就给成品方案');
    expect(adapted).not.toContain('不要先反问');
    expect(adapted).not.toContain('浏览器 / danbooru');
    expect(createHash('sha256').update(readFileSync(referencePath('ideation'),'utf8')).digest('hex')).toBe(sourceHash);
  });

  it('adapts writing guidance without legacy mobile tools or workflow rules, retaining prompt craft evidence',()=>{
    const source=readFileSync(referencePath('writing'),'utf8');
    const sourceHash=createHash('sha256').update(source).digest('hex');
    const adapted=adaptPromptingReference('writing',source);
    expect(adapted).toContain('read_generation_state');
    expect(adapted).toContain('接触点必须有主人');
    expect(adapted).toContain('姿势必须词组');
    expect(adapted).toContain('保留用户已配置的默认内容');
    expect(adapted).toContain('主提示词承载场景、镜头、整体氛围和跨角色关系');
    expect(adapted).toContain('角色栏不只限于外观');
    expect(adapted).toContain('局部动作、表情、接触和道具');
    expect(adapted).toContain('不使用前缀时，属于某个角色的表情仍可写入对应角色栏');
    expect(adapted.length).toBeGreaterThan(source.length*0.7);
    for(const stale of ['langbai_','search_tags','Custom position','AGENT_MAX_CHARACTER_SLOTS',
      '工具调用只有 4 步','运行环境已规定','前端画质预设会自动附加','角色栏只写外貌','只放外貌',
      '角色栏只写外貌服装','独立角色栏只管外观，作用是减少角色特征串色','动作 · 表情 · 镜头 · 场景 · 背景一律不进角色栏',
      '动作/表情/镜头/场景/背景','它们一律留在主提示词','角色栏只有性别词+角色名','表情留在主提示词',
      '动作、表情、镜头、场景、背景漏进角色栏','动作、表情、镜头、场景、背景漏进角色栏。它们一律留在主提示词',
      '没挂前缀的图，表情照旧回主提示词','表情照旧回主提示词',
      '没换装不要再列发色']) expect(adapted).not.toContain(stale);
    expect(createHash('sha256').update(readFileSync(referencePath('writing'),'utf8')).digest('hex')).toBe(sourceHash);
  });
});
