import {describe,expect,it} from 'vitest';
import {prepareCharacterLayoutPrompts,type CharacterLayoutPrompt} from './character-layout';

const role=(name:string,prompt:string,useCoords:boolean,x:number,y:number,enabled=true):CharacterLayoutPrompt=>({name,prompt,enabled,useCoords,x,y});

describe('Agent character layout validation',()=>{
  it('requires every participating role to have a finite normalized coordinate when planned',()=>{
    const current:CharacterLayoutPrompt[]=[];
    expect(prepareCharacterLayoutPrompts(current,[role('A','alice',true,.25,.5)],'planned')).toHaveLength(1);
    expect(()=>prepareCharacterLayoutPrompts(current,[{...role('A','alice',true,.25,.5),x:Number.NaN}],'planned')).toThrow(/坐标/);
    expect(()=>prepareCharacterLayoutPrompts(current,[{...role('A','alice',true,.25,.5),y:1.01}],'planned')).toThrow(/坐标/);
    expect(()=>prepareCharacterLayoutPrompts(current,[role('A','alice',false,.5,.5)],'planned')).toThrow(/所有启用角色/);
  });

  it('distinguishes a new explicit free layout from omitted false coordinates',()=>{
    const newRoles=[role('A','alice',false,.5,.5),role('B','bob',false,.5,.5)];
    expect(()=>prepareCharacterLayoutPrompts([],newRoles,undefined)).toThrow(/characterLayoutIntent='free'/);
    expect(prepareCharacterLayoutPrompts([],newRoles,'free')).toEqual(newRoles);
    expect(()=>prepareCharacterLayoutPrompts([],newRoles.map((item,index)=>({...item,useCoords:index===0})), 'free')).toThrow(/所有启用角色/);
  });

  it('checks free intent only for participating roles and preserves disabled layout values',()=>{
    const before=[role('A','alice',true,.2,.4),role('B','bob',true,.8,.6,false)];
    const next=[role('A','alice',false,.5,.5),role('B','bob',true,.8,.6,false)];
    expect(prepareCharacterLayoutPrompts(before,next,'free')).toEqual(next);

    const allDisabled=[role('A','alice',true,.2,.4,false),role('B','bob',true,.8,.6,false)];
    expect(prepareCharacterLayoutPrompts(before,allDisabled,undefined)).toEqual(allDisabled);
  });

  it('does not let free intent move an unmatched disabled role, but permits its explicit deletion',()=>{
    const before=[role('','girl',true,.2,.5),role('','girl',false,.8,.5,false)];
    const renamed=[
      role('','Alice revised',false,.2,.5,true),
      role('','Bob revised',false,.1,.1,false),
    ];
    expect(()=>prepareCharacterLayoutPrompts(before,renamed,'free')).toThrow(/停用角色无法可靠匹配旧布局/);

    // With no disabled row in the replacement list, the old disabled role was
    // explicitly removed; there is no next disabled layout to misapply.
    expect(prepareCharacterLayoutPrompts(before,[renamed[0]],'free')).toEqual([renamed[0]]);

    const preservedLayout=[renamed[0],{...renamed[1],x:.8,y:.5}];
    expect(prepareCharacterLayoutPrompts(before,preservedLayout,'free')).toEqual(preservedLayout);
  });

  it('keeps valid overlaps and center coordinates when the assistant planned them',()=>{
    const planned=[role('A','alice',true,.5,.5),role('B','bob',true,.5,.5)];
    expect(prepareCharacterLayoutPrompts([],planned,undefined)).toEqual(planned);
  });

  it('preserves an existing legacy mixed layout during text edits and pure reorder',()=>{
    const before=[role('A','alice, blue coat',true,.2,.4),role('B','bob, red coat',false,.5,.5)];
    const textEdit=[role('A','alice, green coat',true,.2,.4),role('B','bob, black coat',false,.5,.5)];
    expect(prepareCharacterLayoutPrompts(before,textEdit,undefined)).toEqual(textEdit);
    const reordered=[textEdit[1],textEdit[0]];
    expect(prepareCharacterLayoutPrompts(before,reordered,undefined)).toEqual(reordered);
  });

  it('rejects mixed layout additions or coordinate moves, but accepts an explicit complete plan',()=>{
    const before=[role('A','alice',true,.2,.4),role('B','bob',false,.5,.5)];
    expect(()=>prepareCharacterLayoutPrompts(before,[...before,role('C','carol',false,.5,.5)],undefined)).toThrow(/characterLayoutIntent='free'/);
    expect(()=>prepareCharacterLayoutPrompts(before,[role('A','alice',true,.8,.4),before[1]],undefined)).toThrow(/混合状态/);
    const planned=[role('A','alice',true,.2,.4),role('B','bob',true,.8,.4),role('C','carol',true,.5,.8)];
    expect(prepareCharacterLayoutPrompts(before,planned,'planned')).toEqual(planned);
  });

  it('allows deleting roles from a legacy mixed layout when remaining layouts stay unchanged',()=>{
    const before=[role('A','alice',true,.2,.4),role('B','bob',false,.5,.5),role('C','carol',false,.8,.6)];
    const after=[before[0],before[1]];
    expect(prepareCharacterLayoutPrompts(before,after,undefined)).toEqual(after);
  });

  it('allows existing all-false text edits, deletion, and reorder while requiring intent for additions',()=>{
    const before=[role('A','alice',false,.5,.5),role('B','bob',false,.5,.5)];
    expect(prepareCharacterLayoutPrompts(before,[role('A','alice, smile',false,.5,.5),before[1]],undefined)[0].prompt).toBe('alice, smile');
    expect(prepareCharacterLayoutPrompts(before,[before[1]],undefined)).toEqual([before[1]]);
    expect(prepareCharacterLayoutPrompts(before,[before[1],before[0]],undefined)).toEqual([before[1],before[0]]);
    expect(()=>prepareCharacterLayoutPrompts(before,[...before,role('C','carol',false,.5,.5)],undefined)).toThrow(/characterLayoutIntent='free'/);
    expect(prepareCharacterLayoutPrompts(before,[...before,role('C','carol',false,.5,.5)],'free')).toHaveLength(3);
  });

  it('inherits omitted enabled by stable identity and refuses ambiguous disabled-role matching',()=>{
    const before=[role('A','same prompt',false,.5,.5,false),role('B','same prompt',false,.5,.5,true)];
    const reordered=prepareCharacterLayoutPrompts(before,[
      {name:'B',prompt:'same prompt',useCoords:false,x:.5,y:.5},
      {name:'A',prompt:'same prompt, revised',useCoords:false,x:.5,y:.5},
    ],undefined);
    expect(reordered.map(item=>item.enabled)).toEqual([true,false]);

    const ambiguous=[role('','same prompt',false,.5,.5,false),role('','same prompt',false,.5,.5,true)];
    expect(()=>prepareCharacterLayoutPrompts(ambiguous,[
      {prompt:'same prompt',useCoords:false,x:.6,y:.5},
      {prompt:'same prompt',useCoords:false,x:.5,y:.5},
    ],undefined)).toThrow(/显式提供 enabled/);

    const duplicateRows=[role('','girl',true,.2,.5,true),role('','girl',false,.8,.5,false)];
    expect(()=>prepareCharacterLayoutPrompts(duplicateRows,[
      {prompt:'girl',useCoords:false,x:.8,y:.5},
      {prompt:'girl',useCoords:true,x:.2,y:.5},
    ],undefined)).toThrow(/显式提供 enabled/);
  });
});
