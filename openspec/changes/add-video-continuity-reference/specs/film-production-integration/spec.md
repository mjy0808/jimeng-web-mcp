## ADDED Requirements
### Requirement: Video continuity reference
The production interface SHALL support one reviewed local video as a Seedance 2.5 multimodal reference for a new output segment, without forced frames or editing the source.

#### Scenario: Generate with a previous selected video
- **WHEN** referenceVideo supplies a path, SHA256 and duration and the prompt binds @视频1 and all @图片N
- **THEN** the adapter uploads the exact video, binds material indices independently from image numbers and submits a new-duration unified reference task
- **AND** no edit_input or first/last frame is sent

#### Scenario: Reject unsupported or changed sources
- **WHEN** the source differs from the reviewed SHA256, the model does not support video reference, or current input-video commerce is unavailable
- **THEN** no generation task is submitted and no fallback task is created
