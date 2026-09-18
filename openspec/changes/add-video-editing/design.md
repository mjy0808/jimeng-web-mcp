## Evidence and decisions

Checked https://jimeng.jianying.com/ai-tool/home and its model configuration on 2026-09-18.
Public chunks: 5255.9deeee27ed.js, 8851.c6cb9c8979.js, 9449.84150c75fc.js, 3938.fac02f9566.js, 3566.653825faf0.js, lib-uploader.c525437ed1.js.

- Model dreamina_seedance_45_pro: edit_config allows 4–30 second source clips, adaptive ratio/duration.
- Draft: unified_edit_input.material_list video_info and edit_input.enable/edit_from_material_idx, optional start_timestamp_ms/end_timestamp_ms. No first/last-frame substitution.
- Upload scene 1, VOD ApplyUploadInner / CommitUploadInner (2020-11-19), multipart upload. Video resource duration is milliseconds.
- Commerce: seedance_25_<resolution>_output, not no_input_video_output. Source/selected interval duration. No fixed cost promise.
- Generation duration_ms=-1, adaptive aspect ratio. Timestamp serialization and billing are verified; exact preservation and output shape require a paid live test.
- Source bytes/hash must match human-reviewed Take. Upload credentials never enter saved Film Studio data.
- First version accepts full-duration output only. Segment-only results remain downloaded with an actionable error; do not splice using guessed offsets.
- One edit request per project. Existing selection and cuts remain until result selection. Reuse gates and monitor; no masks, extensions, multi-interval jobs or automatic paid retries.
