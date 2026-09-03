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

#### Scenario: Observed queue progress
- **WHEN** the platform returns non-negative integer queue position or queue length
- **THEN** the query result exposes these optional counts without changing the task identity
- **AND** missing or invalid values stay unavailable; percentages and forecast units are not guessed

### Requirement: Human-gated Film Studio execution
Film Studio SHALL invoke the local MCP using only the current approved execution package and SHALL retain existing human review gates and durable operation records.

#### Scenario: Submit one current item
- **WHEN** a current production gate has a valid human-approved saved prompt and no active operation
- **THEN** the operation is recorded before one generation submission
- **AND** credentials are not included in project state, prompts or tool output

#### Scenario: Resume after interruption
- **WHEN** an active operation exists
- **THEN** execution resumes that task or reports uncertain identity without submitting another task

#### Scenario: Candidate ready for review
- **WHEN** the matching completed result has been downloaded and validated
- **THEN** it enters the existing import and human-review flow
- **AND** execution does not select or approve a candidate automatically

#### Scenario: Director turn ends before the video finishes
- **WHEN** a registered workspace has a current submitted MCP operation
- **THEN** the Film Studio host periodically queries only that saved task and downloads, validates and imports the matching completed video
- **AND** it stops at shot review without a new submission or an agent polling loop
- **AND** queue and execution telemetry update the UI without incrementing creative revisions

#### Scenario: Download or import fails
- **WHEN** the current task cannot be downloaded or imported
- **THEN** the operation records an actionable error and waits for explicit retry
- **AND** retry reuses the original task or downloaded file without consuming another prompt approval
- **AND** concurrent recovery cannot create duplicate imports or revive an abandoned task

#### Scenario: Single MCP production path
- **WHEN** a new film is created
- **THEN** Jimeng MCP is the only image/video production path, with the adapter privately reading fresh login state from the dedicated local Chrome window
- **AND** the adapter opens that window when absent and requests human login only when needed; the director does not read cookies or automate website generation
- **AND** historical ChatGPT metadata remains readable without enabling ChatGPT generation
