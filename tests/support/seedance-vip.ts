/** Sanitized account configuration observed on 2026-10-19; offline only. */
export function vipModels() {
  return [
    { model_req_key: 'dreamina_seedance_40_pro_vision', model_name: '即梦 Seedance 2.0 VIP', prefix: 'seedance_20_pro', resolutions: ['720p', '1080p', '4k'] },
    { model_req_key: 'dreamina_seedance_40_vision', model_name: '即梦 Seedance 2.0 Fast VIP', prefix: 'seedance_20_fast', resolutions: ['720p'] },
  ].map(({ prefix, resolutions, ...model }) => ({ ...model, model_status: 0,
    options: [{ key: 'resolution', forbidden_display: false, enum_val: { string_value: resolutions } }],
    commercial_config: {
      default: { benefit_type: `${prefix}_720p_output` },
      resolution_price_configs: resolutions.map(resolution => ({ resolution, price: {
        benefit_type: `${prefix}_${resolution}_output`, resource_id: 'generate_video', resource_id_type: 'str', resource_sub_type: 'aigc',
      } })),
    },
  }));
}
