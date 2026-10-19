## ADDED Requirements
### Requirement: Exact Seedance Fast selection
The service SHALL map seedance-2.0-fast to dreamina_seedance_40 and validate its current account availability and commerce configuration before reference uploads.

#### Scenario: Fast reference generation
- **WHEN** a caller selects seedance-2.0-fast with image references and 720p video
- **THEN** the service SHALL use the exact Fast model and unified reference input, without falling back to Pro or VIP

#### Scenario: Fast unavailable
- **WHEN** the current account does not expose that Fast model or its commerce configuration
- **THEN** the request SHALL be rejected before upload or generation
