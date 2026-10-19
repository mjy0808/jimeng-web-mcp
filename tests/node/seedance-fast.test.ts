import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VideoService, VideoSubmissionRejectedError } from '../../src/api/VideoService.js';
import { validateProductionSubmit } from '../../src/production-tools.js';

function fixture(available = true) {
 const calls: string[] = []; let body: any;
 const http = { generateRequestParams: () => ({}), request: async (input: any) => {
  calls.push(input.url);
  if (input.url.includes('get_common_config')) return {ret:'0',data:{model_list:available ? [{model_req_key:'dreamina_seedance_40',model_name:'即梦 Seedance 2.0 Fast',model_status:0,options:[{key:'resolution',enum_val:{string_value:['720p']}}],commercial_config:{default:{benefit_type:'dreamina_seedance_20_fast',resource_id:'generate_video',resource_id_type:'str',resource_sub_type:'aigc'}}}] : []}};
  body=input.data; return {data:{aigc_data:{submit_id:'offline-task'}}};
 }};
 const uploader = {upload: async (path: string) => {calls.push('upload:'+path);return {uri:'reference',width:1024,height:1536,format:'png'};}};
 return {service:new VideoService(http as any,uploader as any),calls,body:()=>body};
}
test('Fast uses exact model, current commerce and unified image reference after preflight',async()=>{
 const f=fixture();
 await f.service.generateTextToVideo({model:'seedance-2.0-fast',prompt:'@图片1 跨步重斩',referenceImages:['/source.png'],resolution:'720p',duration:5000,fps:24,async:true});
 assert.deepEqual(f.calls,['/mweb/v1/video_generate/get_common_config','upload:/source.png','/mweb/v1/aigc_draft/generate']);
 const draft=JSON.parse(f.body().draft_content);const params=draft.component_list[0].abilities.gen_video.text_to_video_params;
 assert.equal(params.model_req_key,'dreamina_seedance_40');
 assert.ok(params.video_gen_inputs[0].unified_edit_input);
 assert.equal(params.video_gen_inputs[0].first_frame_image,undefined);
 assert.equal(f.body().extend.m_video_commerce_info.benefit_type,'dreamina_seedance_20_fast');
 assert.equal(f.body().extend.m_video_commerce_info.amount,5);
});
test('unavailable Fast fails before upload or generation',async()=>{
 const f=fixture(false);
 await assert.rejects(f.service.generateTextToVideo({model:'seedance-2.0-fast',prompt:'@图片1 动作',referenceImages:['/source.png'],async:true}),VideoSubmissionRejectedError);
 assert.deepEqual(f.calls,['/mweb/v1/video_generate/get_common_config']);
});
test('Fast rejects unsupported resolution, duration and fps without effects',async()=>{
 for(const controls of [{resolution:'1080p'},{duration:16000},{fps:30}]){
  const f=fixture();await assert.rejects(f.service.generateTextToVideo({model:'seedance-2.0-fast',prompt:'test',async:true,...controls} as any));assert.deepEqual(f.calls,[]);
 }
 const request={submitId:'00000000-0000-4000-8000-000000000001',mediaType:'video',prompt:'@图片1 动作',model:'seedance-2.0-fast',references:['/source.png'],ratio:'16:9',resolution:'720p',durationSeconds:5};
 assert.doesNotThrow(()=>validateProductionSubmit(request as any));
 assert.throws(()=>validateProductionSubmit({...request,resolution:'1080p'} as any));
});
