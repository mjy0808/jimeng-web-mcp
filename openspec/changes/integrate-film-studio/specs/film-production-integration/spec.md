## ADDED Requirements

### Requirement: Complete Seedance image references
The MCP server SHALL support the complete ordered image reference set for supported Seedance 2.0 and 2.5 generation modes without silently dropping references, rewriting authored prompt text, or switching models.

#### Scenario: Multiple approved film references
- **WHEN** a supported request contains ordered character, location, prop and style images
- **THEN** all images are uploaded and bound to the matching prompt reference indices
- **AND** the request uses the explicitly selected model and supported settings

#### Scenario: Unsupported mode or settings
- **WHEN** the requested reference role, image count, model or settings cannot be represented by the selected mode
- **THEN** the request fails before billable submission with an actionable explanation
- **AND** no substitute model or reduced reference set is submitted

#### Scenario: Approved previous take supplies a first frame
- **WHEN** the approved film shot requests previous-last-frame continuity
- **THEN** Film Studio uses the current approved previous take's extracted tail, not the newest candidate, as the only uploaded first-frame input
- **AND** the MCP submits first_frame_image and the exact plain-text prompt, without unified_edit_input
- **AND** all asset design references remain visible to the author as non-uploaded design context, with this distinction shown before execution

#### Scenario: Invalid first-frame source or mixed modes
- **WHEN** the approved tail is missing, outside the current film, or a request combines first-frame and unified references
- **THEN** no billable submission occurs and no substitute input is selected

#### Scenario: Upstream take changes
- **WHEN** the selected previous take changes
- **THEN** downstream shot dependency hashes change through the existing invalidation flow
- **AND** an interrupted submission only resumes its saved task ID and does not generate another take automatically

### Requirement: Machine-readable generation lifecycle
The MCP server SHALL return a stable machine-readable submission identity and query result alongside existing human-readable output.

#### Scenario: Successful task lookup
- **WHEN** a caller queries a known task
- **THEN** the result identifies its status, media type and completed output URLs without requiring display-text parsing

#### Scenario: Invalid or incomplete output
- **WHEN** a query contains only a video cover, failed task or an unexpected image count
- **THEN** the caller cannot mistake it for a completed valid film result

### Requirement: Human-gated Film Studio execution
Film Studio SHALL invoke the local MCP using only the current approved execution package and SHALL retain existing human review gates and durable operation records.

#### Scenario: Submit one current item
- **WHEN** a current production gate has a valid exported prompt and no active operation
- **THEN** the operation is recorded before one generation submission
- **AND** credentials are not included in project state, prompts or tool output

#### Scenario: Resume after interruption
- **WHEN** an active operation exists
- **THEN** execution resumes that task or reports uncertain identity without submitting another task

#### Scenario: Candidate ready for review
- **WHEN** the matching completed result has been downloaded and validated
- **THEN** it enters the existing import and human-review flow
- **AND** execution does not select or approve a candidate automatically

#### Scenario: Single MCP production path
- **WHEN** a new film is created
- **THEN** Jimeng MCP is the only image/video production path and does not depend on an open browser
- **AND** historical ChatGPT metadata remains readable without enabling ChatGPT generation
