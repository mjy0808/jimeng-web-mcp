## ADDED Requirements

### Requirement: Seedance 2.5 sample submissions
The MCP server SHALL submit a requested Seedance 2.5 sample as a Draft task and SHALL distinguish it from ordinary 480p generation.

#### Scenario: Valid sample
- **WHEN** `production_submit` receives `model=seedance-2.5`, `resolution=480p`, and `draft=true`
- **THEN** the video generation input includes `is_draft_mode=true` and the Draft-capable version
- **AND** the existing submit ID and query lifecycle are preserved

#### Scenario: Unsupported sample settings
- **WHEN** `draft=true` is paired with another model, resolution, or image media type
- **THEN** the request is rejected before upload or billable submission
- **AND** it is not silently submitted as a standard video

#### Scenario: Film Studio review and recovery
- **WHEN** a film selects Seedance 2.5 sample mode
- **THEN** its video resolution is limited to 480p and the prompt review and operation records show sample mode
- **AND** the adapter checks that the MCP advertises the draft parameter before submission
- **AND** recovery queries the original sample task without submitting a replacement
