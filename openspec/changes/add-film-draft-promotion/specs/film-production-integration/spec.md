## ADDED Requirements

### Requirement: Independent film target and Draft resolutions
The Film Studio SHALL store the final film resolution independently of the 480p Seedance 2.5 Draft request resolution.

#### Scenario: 1080p film with 480p Draft
- **WHEN** a film targets 1080p and selects Seedance 2.5 sample mode
- **THEN** its sample production unit is submitted with `is_draft_mode=true` and `resolution=480p`
- **AND** the film retains 1080p as its final output target
- **AND** the prompt and task ledger distinguish the sample resolution from the final target

### Requirement: Promotion of an approved Draft production unit
The Film Studio SHALL allow the user to choose one approved Draft production unit for high-definition finalization based on its original Draft task and item.

#### Scenario: One unit is promoted
- **WHEN** the user chooses an approved sample production unit for promotion
- **THEN** the studio records a new task ID before provider submission
- **AND** the MCP submits a GenerateFromDraft request referencing the original history and item at the film's target resolution
- **AND** the other production units and approved sample Takes remain unchanged

#### Scenario: Provider or source does not support promotion
- **WHEN** the source is not an original completed Draft or the live model configuration does not allow the final resolution
- **THEN** the MCP rejects the request before a paid generate call and does not substitute a standard generation

#### Scenario: Final video is returned
- **WHEN** the promotion task completes
- **THEN** its video is imported as a new Take, or a multi-shot result waits for confirmed split points
- **AND** every resulting Take requires review before replacing the approved sample
- **AND** a restarted worker only queries the saved promotion task ID after submission was attempted
