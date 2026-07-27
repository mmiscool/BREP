import { generate3MF } from '../exporters/threeMF.js';
import { buildSheetMetalFlatPatternPackageFiles } from '../features/sheetMetal/flatPatternFiles.js';
import { fs } from '../fs.proxy.js';
import { PartHistory } from "../PartHistory.js";
import { posix as path } from '../path.proxy.js';
import { registerSketchSolverTopologyFixtureTests } from './sketchSolverTopologyFixtureLoader.js';
import { getSolidVolumeExpectations } from './solidVolumeExpectations.js';
import {
    assertSceneSolidVolumeExpectations,
    getSceneSolids,
} from './solidVolumeTestUtils.js';
import { test_boolean_subtract } from './test_boolean_subtract.js';
import {
    afterRun_boolean_operation_target_name_preserved,
    test_boolean_operation_target_name_preserved,
} from './test_boolean_operation_target_name.js';
import { test_boolean_face_metadata_preserved } from './test_boolean_face_metadata_preserved.js';
import {
    test_boolean_overlap_conditioning_direct_api_can_be_disabled,
    test_boolean_overlap_conditioning_direct_api_enabled_by_default,
    test_boolean_overlap_conditioning_subtract_expands_tool_entry_cap_outward,
    test_boolean_overlap_conditioning_subtract_can_be_disabled,
    test_boolean_overlap_conditioning_subtract_enabled_by_default,
    test_boolean_overlap_conditioning_union_can_be_disabled,
    test_boolean_overlap_conditioning_union_enabled_by_default,
} from './test_boolean_overlap_conditioning.js';
import {
    test_cam_plan_manager_preserves_operations_and_profiles,
    test_cam_plan_manager_async_generation_reports_progress_steps,
    test_cam_plan_manager_strips_legacy_generated_data,
    test_cam_shadow_cutter_cuts_each_loop_to_depth_before_next_loop,
    test_cam_shadow_cutter_generates_clear_hole_loop,
    test_cam_shadow_cutter_generates_outer_and_hole_for_nonconvex_profile,
    test_cam_shadow_cutter_history_item_generates_toolpath,
    test_cam_shadow_cutter_ignores_raised_cap_loops_as_holes,
    test_cam_shadow_cutter_offset_keeps_l_shape_inside_corner_clear,
    test_cam_shadow_cutter_offset_stays_outside_concave_shadow,
    test_cam_roughing_history_item_generates_sliced_toolpaths,
    test_cam_roughing_keeps_vertical_cutter_clear_of_overhangs,
    test_cam_roughing_debug_slices_emit_layer_solids,
    test_cam_roughing_debug_slices_create_real_scene_solids,
    test_cam_roughing_debug_slices_survive_combined_cam_plan,
    test_cam_roughing_sloped_slab_generates_each_step,
    test_cam_roughing_unions_curved_slice_shadow_before_pathing,
    test_cam_roughing_uses_each_slice_shadow,
    test_cam_roughing_vertical_wall_slice_matches_shadow_cutter_loop,
    test_cam_surfacing_adaptive_sampling_inserts_points_on_curved_face,
    test_cam_surfacing_applies_parent_transform_to_direct_face_geometry,
    test_cam_surfacing_both_raster_directions_emit_x_and_y_paths,
    test_cam_surfacing_clearance_link_samples_narrow_preserved_geometry,
    test_cam_surfacing_combined_gcode_posts_single_runnable_program,
    test_cam_surfacing_combined_gcode_reissues_feed_after_roughing,
    test_cam_surfacing_detects_narrow_preserved_island_between_coarse_samples,
    test_cam_surfacing_does_not_cut_across_selected_face_hole,
    test_cam_surfacing_does_not_duplicate_direct_face_with_owner_metadata,
    test_cam_surfacing_falls_back_to_full_retract_when_low_hop_reaches_safe_height,
    test_cam_surfacing_flat_path_tolerance_zero_respects_sample_spacing,
    test_cam_surfacing_follows_sloped_face_with_drop_cutter,
    test_cam_surfacing_history_item_generates_ball_endmill_raster,
    test_cam_surfacing_rejects_vertical_face_without_projected_area,
    test_cam_surfacing_reaches_edge_beside_coplanar_preserved_face,
    test_cam_surfacing_reports_warning_when_raster_too_dense,
    test_cam_surfacing_resolves_solid_owned_face_reference,
    test_cam_surfacing_splits_runs_around_preserved_island,
    test_cam_surfacing_stops_before_higher_adjacent_preserved_face,
    test_cam_surfacing_stock_allowance_leaves_material_on_selected_face,
    test_cam_surfacing_ui_reference_metadata_preserves_shared_face_owner,
    test_cam_surfacing_uses_low_clearance_links_between_separate_face_spans,
    test_cam_surfacing_uses_userdata_solid_owner_for_shared_face_name,
    test_cam_surfacing_uses_explicit_solid_owner_for_shared_face_name,
    test_cam_surfacing_y_raster_reaches_selected_face_edges,
    test_cam_surfacing_zero_sample_spacing_uses_automatic_spacing,
    test_cam_shadow_cutter_single_solid_does_not_require_target_selection,
    test_cam_toolpath_simulator_displays_ball_endmill_round_tip,
    test_cam_toolpath_simulator_visualizes_program_and_moves_head,
    test_cam_shadow_cutter_uses_projected_outline_not_convex_hull,
    test_cam_workbench_exit_clears_scene_artifacts,
    test_cam_workbench_registers_shadow_cutter_and_roughing_operations,
    test_cam_workbench_registers_and_persists_part_history_state,
} from './test_camWorkbench.js';
import {
    test_cam_shadow_cutter_generated_history_20260704000935_keeps_outer_loop,
} from './test_cam_shadow_cutter_generated_history.js';
import {
    test_generated_history_20260715000656,
} from './test_cam_generated_history_20260715000656.js';
import { test_Chamfer } from './test_chamfer.js';
import {
    test_cppChamfer_auto_direction_uses_native_classifier,
    test_cppChamfer_bridges_nearly_tangent_adjacent_end_caps,
    test_cppChamfer_debug_emits_cross_section_face_per_sample,
    test_cppChamfer_debug_sections_materialize_as_sketch_profiles,
    test_cppChamfer_projects_open_end_caps_back_to_endpoint_plane,
    test_cppChamfer_single_edge_builds_native_named_tool_and_result,
    test_cppChamfer_stabilizes_tiny_terminal_segments_before_offsetting,
} from './test_cppChamfer.js';
import {
    test_edge_smooth_constraints_prevent_triangle_foldback,
    test_edge_smooth_closed_loop_feature_selection,
    test_edge_smooth_curve_fit,
    test_edge_smooth_curve_fit_closed_loop,
    test_edge_smooth_face_selection,
    test_edge_smooth_whole_solid_selection,
} from './test_edge_smooth_curve_fit.js';
import {
    afterRun_extrude_negative_distance_cap_alignment,
    test_extrude_negative_distance_cap_alignment,
} from './test_extrude_negative_distance.js';
import {
    afterRun_extrude_intersect_coplanar_face_merge,
    test_extrude_intersect_coplanar_face_merge,
} from './test_extrude_intersect_coplanar_face_merge.js';
import { test_face_source_feature_seed } from './test_face_source_feature_seed.js';
import { test_file_manager_missing_model_rejects_without_alert } from './test_file_manager_programmatic_load_errors.js';
import {
    afterRun_extrude_solid_face_uses_boundary_edge_sidewalls,
    test_ExtrudeFace,
    test_extrude_solid_face_uses_boundary_edge_sidewalls,
} from './test_extrudeFace.js';
import {
    afterRun_generated_history_20260709065543,
    test_generated_history_20260709065543,
    test_generated_history_20260709065543_base_thickness,
} from './test_generated_history_20260709065543.js';
import {
    test_extrude_rectangle_profile_has_one_sidewall_per_sketch_edge,
    test_feature_edge_name_resolution_prefers_boolean_result_over_raw_tool,
    test_generated_history_20260609165436_six_edge_profile_has_six_sidewalls,
    test_generated_history_20260609042734_preserves_s22_subtract_sidewalls,
    test_generated_history_20260609045351_fillet_expanded_replay_uses_subtract_result,
    test_generated_history_20260609074231_outset_fillet_end_caps_merge_into_planar_faces,
    test_generated_history_20260609150657_outset_fillet_start_end_caps_merge_into_planar_face,
    test_run_history_calls_are_serialized,
    test_subtract_restore_rejects_raw_tool_added_snapshot,
    test_subtract_extrude_preserves_rectangle_tool_sidewall_faces,
} from './test_extrude_sidewall_face_tracking.js';
import { test_Fillet } from './test_fillet.js';
import { afterRun_fillet_angle, test_fillet_angle } from './test_fillet_angle.js';
import {
    afterRun_fillet_edge_degenerate_segment,
    test_fillet_edge_degenerate_segment,
} from './test_fillet_edge_degenerate_segment.js';
import {
    afterRun_sketch_profile_tolerant_loop_join,
    test_sketch_profile_tolerant_loop_join,
} from './test_sketch_profile_tolerant_loop_join.js';
import {
    afterRun_fillet_compound_snapshot_resolution,
    test_fillet_compound_snapshot_resolution,
} from './test_fillet_compound_snapshot_resolution.js';
import {
    afterRun_fillet_generated_history_20260321144106,
    test_fillet_generated_history_20260321144106,
} from './test_fillet_generated_history_20260321144106.js';
import {
    afterRun_generated_history_20260322220620,
    test_generated_history_20260322220620,
} from './test_generated_history_20260322220620.js';
import {
    afterRun_generated_history_20260322222832,
    test_generated_history_20260322222832,
} from './test_generated_history_20260322222832.js';
import {
    afterRun_generated_history_20260418030116,
    test_generated_history_20260418030116,
} from './test_generated_history_20260418030116.js';
import {
    afterRun_generated_history_20260427005357,
    afterRun_generated_history_20260427005357_nine_face_thicken,
    afterRun_generated_history_20260427005357_three_face_thicken,
    test_generated_history_20260427005357,
    test_generated_history_20260427005357_nine_face_thicken,
    test_generated_history_20260427005357_three_face_thicken,
} from './test_generated_history_20260427005357.js';
import { test_generated_history_20260523000414 } from './test_generated_history_20260523000414.js';
import { test_generated_history_20260531201126 } from './test_generated_history_20260531201126.js';
import { test_generated_history_20260606004152 } from './test_generated_history_20260606004152.js';
import {
    test_generated_history_20260607180752_offset_shell_cleanup_toggles_disable_pipe_collapse,
    test_generated_history_20260607180752_offset_shell_negative_half_is_manifold,
    test_generated_history_20260607180752_offset_shell_negative_one_keeps_cleanup,
} from './test_generated_history_20260607180752.js';
import {
    afterRun_generated_history_20260612230031,
    test_generated_history_20260612230031,
} from './test_generated_history_20260612230031.js';
import { test_generated_history_20260709035143_offset_shell_prefers_source_face_names } from './test_generated_history_20260709035143.js';
import {
    afterRun_generated_history_20260612232755,
    test_generated_history_20260612232755,
} from './test_generated_history_20260612232755.js';
import {
    afterRun_generated_history_20260613000139,
    test_generated_history_20260613000139,
} from './test_generated_history_20260613000139.js';
import {
    afterRun_generated_history_20260613003952,
    test_generated_history_20260613003952,
} from './test_generated_history_20260613003952.js';
import {
    afterRun_fillet_preserves_original_face_names,
    test_fillet_preserves_original_face_names,
} from './test_fillet_preserves_original_face_names.js';
import {
    afterRun_fillet_corner_bridge,
    test_fillet_corner_bridge,
} from './test_fillet_corner_bridge.js';
import {
    test_fillet_cache_invalidates_when_target_solid_changes_away_from_selected_edges,
    test_fillet_rebuild_re_resolves_stale_edge_object,
    test_history_delete_restores_removed_upstream_solid_from_source_feature,
    test_reference_selection_timestamp_scope_preserves_unchanged_edge_cache,
} from './test_fillet_stale_reference_rebuild.js';
import { afterRun_Fillet_NonClosed, test_Fillet_NonClosed } from './test_fillet_nonClosed.js';
import { test_fillets_more_dificult } from './test_filletsMoreDifficult.js';
import { afterRun_history_expand_does_not_dirty, test_history_expand_does_not_dirty } from './test_history_expand_does_not_dirty.js';
import {
    test_history_test_snippet_includes_cam_operations,
    test_history_test_snippet_includes_global_cam_state_without_operations,
    test_history_test_snippet_omits_empty_cam_state,
    test_history_test_snippet_persistent_data_allowlist,
    test_history_test_snippet_toolbar_snapshot_compacts_cam_generated_data,
} from './test_historyTestSnippetPersistentData.js';
import { afterRun_history_features_basic, test_history_features_basic } from './test_history_features_basic.js';
import {
    afterRun_hole_counterbore,
    afterRun_hole_countersink,
    afterRun_hole_multi_point_cloned_cutter,
    afterRun_hole_thread_modeled,
    afterRun_hole_thread_symbolic,
    afterRun_hole_through,
    test_hole_counterbore,
    test_hole_countersink,
    test_hole_multi_point_cloned_cutter,
    test_hole_thread_modeled,
    test_hole_thread_symbolic,
    test_hole_through,
} from './test_hole.js';
import {
    afterRun_import3d_decimation_100_restores_original_geometry,
    afterRun_import3d_decimation_99_is_near_full_detail,
    afterRun_import3d_decimation_preserves_source_snapshot_without_json_clone,
    afterRun_import3d_decimation_reapplies_from_cached_source_mesh,
    afterRun_import3d_decimation_reduces_triangle_count,
    afterRun_import3d_decimation_seeds_source_snapshot_for_legacy_cache,
    test_import3d_decimation_100_restores_original_geometry,
    test_import3d_decimation_99_is_near_full_detail,
    test_import3d_decimation_preserves_source_snapshot_without_json_clone,
    test_import3d_decimation_reapplies_from_cached_source_mesh,
    test_import3d_decimation_reduces_triangle_count,
    test_import3d_decimation_seeds_source_snapshot_for_legacy_cache,
} from './test_import3dDecimation.js';
import {
    afterRun_import3d_extract_multiple_solids_toggle,
    test_import3d_extract_multiple_solids_toggle,
} from './test_import3dMultipleSolids.js';
import {
    afterRun_import3d_planar_extraction_merges_sliver_bridge,
    test_import3d_fixture_merges_faces_4_and_34,
    test_import3d_planar_extraction_keeps_small_flat_patch_edges,
    test_import3d_planar_extraction_merges_near_coplanar_patch_back_into_neighbor,
    test_import3d_planar_extraction_merges_sliver_bridge,
} from './test_import3dPlanarExtraction.js';
import { test_mirror } from './test_mirror.js';
import { test_pattern_circular_count_pitch_uses_angle_as_step } from './test_patternFeature.js';
import {
    test_mesh_cleanup_split_crossing_triangles_inserts_intersection_edges,
    test_mesh_cleanup_split_point_intersection_inserts_vertex,
    test_mesh_cleanup_split_then_winding_removes_internal_overlap,
    test_mesh_cleanup_find_one_triangle_intersected_by_multiple_triangles,
    test_mesh_cleanup_two_cut_segments_cross_inside_same_triangle,
    test_mesh_cleanup_intersection_endpoint_on_shared_mesh_edge,
    test_mesh_cleanup_detects_coplanar_partial_triangle_overlap,
    test_mesh_cleanup_removes_geometrically_duplicate_triangles,
    test_mesh_cleanup_removes_closed_box_completely_inside_another,
    test_mesh_cleanup_overlapping_boxes_volume_equals_union,
    test_mesh_cleanup_disjoint_closed_boxes_are_preserved,
    test_mesh_cleanup_preserves_face_ids_after_splitting,
    test_mesh_cleanup_complete_operation_is_idempotent,
} from './test_meshCleanupSelfIntersection.js';
import {
    afterRun_fillet_face_names_and_merge_metadata_survive_native_manifold_rebuild,
    test_cppNative_prepareManifoldMesh_matches_legacy_js_reference,
    test_fillet_face_names_and_merge_metadata_survive_native_manifold_rebuild,
} from './test_cppFaceNamingRegression.js';
import { test_configurator_expressions } from './test_configuratorExpressions.js';
import {
    test_cppSolidCore_boundaryQueries_match_geometric_edges_on_split_authoring_mesh,
    test_cppSolidCore_preserves_face_ids_and_metadata,
    test_cppSolidCore_prepareManifoldMesh_repairs_orientation,
    test_cppSolidCore_pushFace_moves_vertices_for_face,
    test_cppSolidCore_removeDisconnectedIslandsByVolume_drops_small_shells,
    test_cppSolidCore_setAuthoringState_and_bakeTransform,
    test_cppSolidCore_topologyQueries_return_native_face_and_edge_payloads,
    test_cppSolidCore_weldVerticesByEpsilon_aligns_authoring_points_without_compacting_buffers,
    test_cppSolidCore_weldVerticesByEpsilon_aligns_neighboring_cells_by_true_distance,
} from './test_cppSolidCore.js';
import {
    test_cppSolidBakeTransform_updates_solid_authoring_state,
    test_cppSolidMirror_preserves_face_metadata,
} from './test_cppSolidBakeTransform.js';
import {
    test_cppSolidNative_booleanCombinedAuthoringState_preserves_face_names_and_metadata,
    test_cppSolidNative_booleanResults_apply_fixed_post_weld_epsilon,
    test_cppSolidNative_buildFilletEdgeAuthoringState_returns_standard_edge_snapshots,
    test_cppSolidNative_collapseFilletSideWallFaces_collapses_away_from_round_face,
    test_cppSolidNative_collapseFilletSideWallFaces_collapses_strip_vertices,
    test_cppSolidNative_collapseFilletSideWallFaces_moves_shared_endcap_edge_vertices,
    test_cppSolidNative_collapseFilletSideWallFaces_preserves_shared_endpoint_junctions,
    test_cppSolidNative_cleanupTinyFaceIslands_reassigns_small_face_and_prunes_metadata,
    test_cppSolidNative_filletEdge_finalSnapshot_preserves_face_names_and_metadata,
    test_cppSolidNative_filletEdge_inflate_offsets_edge_wedge_corner_in_both_tangent_directions,
    test_cppSolidNative_filletEdge_nudgeFaceDistance_moves_only_end_cap_vertices,
    test_cppSolidNative_classifyFilletEdgeDirection_cubeConvexEdge_isInset,
    test_cppSolidNative_deduplicateFaceNames_reassigns_duplicate_triangles_to_first_id,
    test_cppSolidNative_getFaceNormal_reports_planar_face_normal,
    test_cppSolidNative_manifoldize_repairs_incoherent_winding,
    test_cppSolidNative_mergeTinyFaces_merges_small_adjacent_face,
    test_cppSolidNative_mergeCoplanarAdjacentFilletEndCaps_retags_triangles_to_planar_neighbor,
    test_cppSolidNative_postBoolean_fillet_merges_coplanar_cube_end_caps,
    test_cppSolidNative_postBoolean_fillet_reverse_end_cap_nudge_requires_merge,
    test_cppSolidNative_reassignTinyFilletSidewallSliverTriangles_merges_triangle_whose_vertices_lie_on_single_planar_face_boundary,
    test_cppSolidNative_reversePostBooleanFilletEndCapNudge_skips_faces_that_share_vertices_with_fillet_sidewalls,
    test_cppSolidNative_solidFillet_preserves_tube_centerline_aux_edge,
    test_cppSolidNative_pushFace_updates_planar_face_vertices,
    test_cppSolidNative_removeInternalTriangles_preserves_clean_manifold_shell,
    test_cppSolidNative_removeSmallIslands_drops_external_shell_and_prunes_metadata,
    test_cppSolidNative_setEpsilon_welds_vertices,
    test_cppSolidNative_setEpsilon_merges_cell_boundary_pair_and_rebuilds_manifold,
} from './test_cppSolidNativeOps.js';
import {
    test_cppTube_closed_hollow_tube_preserves_expected_face_labels,
    test_cppTube_feature_inner_cutter_nudges_open_end_caps,
    test_cppTube_native_auto_falls_back_to_slow_on_foldback_path,
    test_cppTube_native_builder_reports_selected_build_mode,
    test_cppTube_open_tube_preserves_expected_face_labels,
    test_cppTube_slow_fallback_union_preserves_external_cap_label,
    test_cppTube_union_preserves_distinct_face_labels_across_native_snapshots,
} from './test_cppTube.js';
import {
    test_cppPrimitive_cone_preserves_expected_face_labels_and_metadata,
    test_cppPrimitive_cube_preserves_expected_face_labels,
    test_cppPrimitive_cylinder_preserves_expected_face_labels_and_metadata,
    test_cppPrimitive_sphere_preserves_single_face_label,
    test_cppPrimitive_torus_and_pyramid_preserve_face_labels,
} from './test_cppPrimitives.js';
import { test_manifoldPlus_sum } from './test_manifoldPlus.js';
import {
    afterRun_offsetFace_preserves_individual_edges,
    test_offsetFace_preserves_individual_edges,
} from './test_offsetFace_preserves_individual_edges.js';
import { test_offsetShell_preserves_source_centerlines } from './test_offsetShellGrouping.js';
import {
    afterRun_offsetShell_debug_separates_rounded_tube_remainder,
    afterRun_offsetShell_negative_distance_rounds_unselected_solid_edges,
    afterRun_offsetShell_repro_20260607082324_removes_area_loss_sidewall,
    afterRun_offsetShell_repro_20260608054724_reassign_preserves_g3_end_and_start_end_faces,
    afterRun_offsetShell_thickens_all_faces_except_selected,
    test_offsetShell_area_loss_sidewall_reassigns_to_dominant_neighbor,
    test_offsetShell_area_loss_sidewall_reassign_preserves_source_sidewall_end_cap,
    test_offsetShell_area_loss_sidewall_reassign_skips_protected_open_face_neighbor,
    test_offsetShell_debug_separates_rounded_tube_remainder,
    test_offsetShell_negative_distance_rounds_unselected_solid_edges,
    test_offsetShell_negative_distance_skips_edges_without_union_sidewall,
    test_offsetShell_pipe_sliver_collapse_falls_back_to_shortest_edge,
    test_offsetShell_pipe_sliver_collapse_moves_only_pipe_vertices,
    test_offsetShell_repro_20260607082324_removes_area_loss_sidewall,
    test_offsetShell_repro_20260608054724_reassign_preserves_g3_end_and_start_end_faces,
    test_offsetShell_thickens_all_faces_except_selected,
} from './test_offsetShellExcludedFaces.js';
import {
    afterRun_thicken_feature_connected_faces_remain_individual_solids,
    afterRun_thicken_feature_multiple_faces_produce_multiple_solids,
    afterRun_thicken_feature_serializes_and_replays_planar_profile,
    test_face_thicken_curved_cylinder_side,
    test_face_thicken_boundary_uses_smooth_adjacent_face_normals,
    test_face_thicken_connected_patch_preserves_source_cap_faces,
    test_face_thicken_filleted_planar_face_keeps_clean_boundaries,
    test_face_thicken_groups_curved_patch_by_shared_edge_normals,
    test_face_thicken_hole_profile,
    test_face_thicken_partial_torus_side_avoids_internal_voids,
    test_face_thicken_planar_profile,
    test_face_thicken_selected_adjacent_normals_accept_relaxed_angle_threshold,
    test_face_thicken_selected_adjacent_normals_match_shared_offset_edge,
    test_face_thicken_self_overlap_cylinder_side,
    test_thicken_feature_connected_faces_remain_individual_solids,
    test_thicken_feature_multiple_faces_produce_multiple_solids,
    test_thicken_feature_serializes_and_replays_planar_profile,
} from './test_thickenFeature.js';
import {
    afterRun_thicken_sphere_torus_union,
    test_thicken_sphere_torus_union,
} from './test_thicken_sphere_torus_union.js';
import {
    test_face_id_repair_uses_metadata_roles_without_name_suffixes,
    test_face_id_repair_accepts_feature_scoped_metadata_roles,
    test_solid_face_queries_fall_back_to_authoring_arrays_for_non_manifold_meshes,
    test_visualize_does_not_repair_face_ids,
} from './test_face_id_repair.js';
import { test_plane } from './test_plane.js';
import { test_primitiveCone } from './test_primitiveCone.js';
import { test_primitiveCube } from './test_primitiveCube.js';
import { test_primitiveCylinder } from './test_primitiveCylinder.js';
import { test_primitivePyramid } from './test_primitivePyramid.js';
import { test_primitiveSphere } from './test_primitiveSphere.js';
import { afterRun_primitiveTorus, test_primitiveTorus } from './test_primitiveTorus.js';
import { afterRun_pushFace_feature, test_pushFace_feature } from './test_pushFace_feature.js';
import { afterRun_pushFace, test_pushFace } from './test_pushFace.js';
import { test_sheetMetal_corner_fillet } from './test_sheetMetal_corner_fillet.js';
import { test_sheetMetal_corner_fillet_face_cylindrical_metadata } from './test_sheetMetal_corner_fillet_face_cylindrical_metadata.js';
import { test_sheetMetal_bend_face_cylindrical_metadata } from './test_sheetMetal_bend_face_cylindrical_metadata.js';
import { test_sheet_clipboard_image_utils } from './test_sheetClipboardImageUtils.js';
import { test_sheetMetal_corner_fillet_compound_reference } from './test_sheetMetal_corner_fillet_compound_reference.js';
import { test_sheetMetal_corner_fillet_selection_resolution } from './test_sheetMetal_corner_fillet_selection_resolution.js';
import { test_sheetMetal_tab_and_flange_context_buttons } from './test_sheetMetal_context_buttons.js';
import {
    afterRun_sheetMetal_cutout_preserves_multiple_profile_loops,
    test_sheetMetal_cutout_preserves_multiple_profile_loops,
} from './test_sheetMetal_cutout_multiple_profile_loops.js';
import { test_sheetMetal_cutout_context_button } from './test_sheetMetal_cutout_context_button.js';
import { test_sheetMetal_cutoutEdge_flange_controls } from './test_sheetMetal_cutoutEdge_flange_controls.js';
import {
    afterRun_sheetMetal_contour_flange_whole_sketch_selection,
    test_sheetMetal_contour_flange_context_button_prefers_sketch,
    test_sheetMetal_contour_flange_whole_sketch_selection,
} from './test_sheetMetal_contour_flange_sketch_selection.js';
import { test_sheetMetal_nonManifold_sm_f18 } from './test_sheetMetal_nonManifold_sm_f18.js';
import { test_sheetMetal_tab_circular_hole_wall } from './test_sheetMetal_tab_circular_hole_wall.js';
import { test_sheetMetal_flat_pattern_files_use_model_and_feature_names } from './test_sheetMetal_flatPatternFiles.js';
import { test_sheetMetal_flat_pattern_preview_visualize_is_idempotent } from './test_sheetMetal_flatPatternPreview.js';
import {
    afterRun_sketch_openLoop,
    afterRun_sketch_snapshot_restore_selection_handlers,
    test_sketch_openLoop,
    test_sketch_snapshot_restore_selection_handlers,
} from './test_sketch_openLoop.js';
import {
    afterRun_sketch_face_attachment_alignment,
    test_sketch_face_attachment_alignment,
} from './test_sketch_face_attachment_alignment.js';
import {
    test_sketch_solver_distance_slide_large_drop_settles_single_solve,
    test_sketch_solver_line_to_point_distance_constraint,
    test_sketch_solver_topology_coincident_chain,
    test_sketch_solver_topology_coincident_chain_multi_step,
    test_sketch_solver_topology_coincident_loop_no_flip,
    test_sketch_solver_topology_rect_round_trip_sequence,
    test_sketch_solver_topology_rect_shared_points,
} from './test_sketch_solver_topology_stability.js';
import { afterRun_solidMetrics, test_solidMetrics } from './test_solidMetrics.js';
import { test_solidPointMinGap } from './test_solidPointMinGap.js';
import { test_stlLoader } from './test_stlLoader.js';
import {
    test_selection_hover_material_restores_before_dispose,
    test_selection_filter_empty_hover_clears_in_place_sketch_hover,
    test_selection_line2_resolution_repair,
    test_selection_owning_feature_resolution,
    test_selection_profile_named_solid_face_hover_does_not_tint_shared_face_material,
    test_selection_sketch_hover_tints_material_in_place,
} from './test_selection_owning_feature.js';
import {
    test_solid_overlap_diagnostics_detects_cross_solid_overlap,
    test_solid_overlap_diagnostics_detects_coplanar_overlap,
    test_solid_overlap_diagnostics_ignores_boundary_touching_faces,
} from './test_solid_overlap_diagnostics.js';
import {
    afterRun_smooth_with_subdivision_preserves_mirrored_union_symmetry,
    afterRun_smooth_with_subdivision_preserves_centered_ring_symmetry,
    afterRun_smooth_with_subdivision_replaces_source_solid,
    test_smooth_with_subdivision_preserves_mirrored_union_symmetry,
    test_smooth_with_subdivision_preserves_centered_ring_symmetry,
    test_smooth_with_subdivision_replaces_source_solid,
} from './test_smooth_with_subdivision.js';
import {
    afterRun_sweepFace_pathAlign_multi_loop_islands,
    test_SweepFace,
    test_SweepFace_pathAlign_multi_loop_islands,
} from './test_sweepFace.js';
import { afterRun_textToFace, test_textToFace } from './test_textToFace.js';
import { test_tube } from './test_tube.js';
import { test_tube_closedLoop } from './test_tube_closedLoop.js';
import { test_wire_harness_formboard_reuses_only_formboard_sheet } from './test_wireHarnessConnectionsWidget.js';
import { test_wire_harness_connection_endpoint_resolution } from './test_wireHarnessConnectionEndpoints.js';
import {
    test_sheet_custom_size_persists,
    test_sheet_metadata_updated_at_is_stable_on_read,
    test_wire_harness_formboard_insert,
} from './test_wireHarnessFormboard.js';
import {
    test_pmi_view_text_size_setting_normalizes,
    test_pmi_view_visibility_state_normalizes,
} from './test_pmiViewsManager.js';
import {
    test_pmi_annotation_failure_status_is_visible,
    test_pmi_linear_dimension_edge_target_measures_perpendicular_to_edge,
    test_pmi_linear_dimension_face_extensions_can_jog_to_measurement_line,
    test_pmi_linear_dimension_face_target_measures_perpendicular_to_face,
    test_pmi_linear_dimension_limits_targets_to_two,
    test_pmi_linear_dimension_parallel_edges_measure_perpendicular_spacing,
    test_pmi_linear_dimension_parallel_faces_measure_plane_spacing,
    test_pmi_linear_dimension_single_edge_still_measures_edge_length,
} from './test_pmiLinearDimension.js';
import {
    test_pmi_radial_dimension_accepts_pipe_aux_path_face,
    test_pmi_radial_dimension_uses_offset_shell_pipe_radius_override,
    test_pmi_radial_dimension_uses_fillet_pipe_radius_override,
} from './test_pmiRadialDimension.js';
import {
    afterRun_pmi_view_visibility_state_round_trip,
    test_pmi_view_visibility_state_round_trip,
} from './test_pmiViewVisibilityState.js';
import {
    test_pmi_enter_edit_mode_reuses_shared_flow,
    test_pmi_effective_visibility_respects_hidden_ancestor,
    test_pmi_export_render_context_applies_visibility_state,
    test_pmi_monochrome_label_layout_is_tighter_than_shaded,
    test_pmi_monochrome_label_svg_uses_backdrop_color,
} from './test_pmiViewsWidget.js';
import {
    test_feature_dimension_annotation_builder_dispatches_pattern,
    test_feature_dimension_annotation_builder_dispatches_registered_primitive,
    test_reference_snapshot_store_uses_generic_reference_snapshots_key,
    test_feature_dimension_effect_reference_resolves_consumed_profile_and_axis,
    test_feature_dimension_overlay_supports_port,
    test_feature_dimension_registry_support_and_transform_toggle_agree,
    test_part_history_prevent_remove_survives_multi_child_scene_clear,
    test_port_extension_annotation_geometry_preserves_extension_value,
    test_transform_control_scene_binding_readds_and_removes_overlay_roots,
} from './test_featureDimensionOverlay.js';
import {
    test_port_definition_uses_transform_reference_and_direction_reference,
    test_port_definition_uses_transform_reference_without_anchor,
    test_referenced_transform_matrix_uses_vertex_reference_origin,
    test_transform_reference_base_uses_face_pick_point,
    test_transform_reference_sanitize_preserves_metadata,
} from './test_transformReferenceUtils.js';
import { test_wire_harness_sheet_table_insert } from './test_wireHarnessSheetTable.js';
import {
    test_wire_harness_infers_endpoint_side_from_spline_direction,
} from './test_wireHarnessRoutingReuse.js';
import { test_wire_harness_routes_render_as_scene_solids } from './test_wireHarnessRouteGeometry.js';
import { test_wire_harness_route_results_persist_in_model_json } from './test_wireHarnessPersistence.js';
import {
    afterRun_visibility_hidden_state_persistence,
    test_visibility_hidden_state_persistence,
} from './test_visibility_hidden_state_persistence.js';
import { test_thicken_feature_is_available_in_modeling_and_surfacing_workbenches } from './test_workbenchFeatureVisibility.js';
import { test_sketch_feature_scene_visibility } from './test_sketchFeatureVisibility.js';
import {
    test_revolve_face_profile_boundary_recovery_marks_inner_loop_as_hole,
    test_revolve_feature_resolves_face_and_edge_string_references,
    test_revolve_axis_edge_profile_reuses_axis_vertices_for_partial_sweep,
    test_revolve_generates_manifold_native_faces_for_axis_edge_profile,
    test_revolve_restored_consumed_sketch_keeps_edge_sidewalls_after_angle_edit,
} from './test_revolveFeature.js';
import {
    afterRun_remesh_simplify_imported_fixture_stl,
    test_remesh_simplify_imported_fixture_stl,
    test_remesh_simplify_uses_kernel_simplify_without_full_tolerance_weld,
    test_solid_simplify_preserves_face_tags_and_metadata,
} from './test_remeshFeature.js';
import {
    test_self_intersection_cleanup_feature_context_button_for_single_solid,
    test_self_intersection_cleanup_feature_is_available_in_modeling_and_surfacing,
    test_self_intersection_cleanup_feature_splits_selected_solid,
} from './test_selfIntersectionCleanupFeature.js';
import { test_revolve_after_union_preserves_face_reference_resolution } from './test_revolve_after_union_face_reference.js';
import {
    afterRun_primitive_boolean_union_preserves_face_grouping,
    test_primitive_boolean_union_preserves_face_grouping,
} from './test_primitive_boolean_face_grouping.js';

declare const process: any;

const IS_NODE_RUNTIME = typeof process !== 'undefined' && process.versions && process.versions.node && typeof window === 'undefined';
const TEST_LOG_PATH = path.join('tests', 'test-run.log.md');
const TEST_LOG_VERSION = 1;
export const BROWSER_LOCAL_FILE_SKIP_REASON = 'Requires a local fixture file that is not loaded in the browser test runner.';
const BROWSER_LOCAL_FILE_ERROR_CODES = new Set(['ENOENT', 'ENOTDIR', 'EISDIR']);
const BROWSER_LOCAL_FILE_PATH_RE = /(?:^|[\s"',`:(]|[\\/])(?:\.{0,2}[\\/])?(?:src\/)?tests\/(?:partFiles|fixtures|importTestingData)\//u;
const BROWSER_LOCAL_FILE_MESSAGE_HINT_RE = /\b(?:part.?history.?json|fixture.?file|fixture.?json|part.?file|imported.?source)\b/iu;
// Browser-only placeholders for Node-discovered filesystem tests. Keep these as
// filenames only so browser builds can list skipped tests without bundling fixtures.
const BROWSER_PART_FILE_TEST_SOURCES = Object.freeze([
    'src/tests/partFiles/badBoolean.json',
    'src/tests/partFiles/extrudeTest.json',
    'src/tests/partFiles/filletFail.json',
    'src/tests/partFiles/fillet_angle_test.BREP.json',
    'src/tests/partFiles/fillet_test.BREP.json',
    'src/tests/partFiles/import_TEst.part.part.json',
    'src/tests/partFiles/medium_fillets.BREP.json',
    'src/tests/partFiles/sketch_throttel_testing.BREP.json',
    'src/tests/partFiles/slowsketch.json',
]);
const BROWSER_SKETCH_SOLVER_FIXTURE_TEST_SOURCES = Object.freeze([
    'src/tests/fixtures/sketchSolverTopology/coincident_chain_fixture.json',
    'src/tests/fixtures/sketchSolverTopology/rect_width_height_fixture.json',
    'src/tests/fixtures/sketchSolverTopology/sketch_throttel_expression_sequence_fixture.json',
]);

function isBrowserRuntime() {
    return typeof window !== 'undefined';
}

function normalizeSkipReason(value, defaultReason) {
    if (!value) return '';
    return value === true ? defaultReason : String(value);
}

function getBrowserLocalFileSkipReason(testFunction) {
    const reason = normalizeSkipReason(testFunction?.requiresLocalFiles, BROWSER_LOCAL_FILE_SKIP_REASON);
    if (reason) return reason;
    if (typeof testFunction?._sourceFile === 'string' && testFunction._sourceFile.length > 0) {
        return BROWSER_LOCAL_FILE_SKIP_REASON;
    }
    return '';
}

function getBrowserLocalFileErrorSkipReason(error) {
    const collectErrorText = (value) => {
        const seen = new Set();
        const parts = [];
        let current = value;
        while (current && typeof current === 'object' && !seen.has(current)) {
            seen.add(current);
            const text = String(current?.message || '');
            if (text) {
                parts.push(text);
            }
            const nextFromCause = current?.cause;
            if (!nextFromCause && Array.isArray(current?.errors) && current.errors.length) {
                current = current.errors[0];
            } else {
                current = nextFromCause;
            }
        }
        if (parts.length === 0) parts.push(String(value || ''));
        return parts.filter(Boolean).join('\n');
    };
    const code = String(error?.code || error?.cause?.code || '');
    const message = collectErrorText(error);
    const stack = String(error?.stack || '');
    const text = `${code}\n${message}\n${stack}`.replace(/\\/g, '/');
    if (!BROWSER_LOCAL_FILE_PATH_RE.test(text)) return '';
    if (BROWSER_LOCAL_FILE_ERROR_CODES.has(code)) return BROWSER_LOCAL_FILE_SKIP_REASON;
    if (/\b(?:ENOENT|ENOTDIR|EISDIR)\b/u.test(text)) return BROWSER_LOCAL_FILE_SKIP_REASON;
    if (/no such file or directory|not loaded in the browser|Browser VFS|path must be a string|not found/iu.test(text)) return BROWSER_LOCAL_FILE_SKIP_REASON;
    if (BROWSER_LOCAL_FILE_MESSAGE_HINT_RE.test(text)) return BROWSER_LOCAL_FILE_SKIP_REASON;
    return '';
}

function getBrowserPartFileSourceFiles() {
    return isBrowserRuntime() ? [...BROWSER_PART_FILE_TEST_SOURCES] : [];
}

function getBrowserSketchSolverFixtureSourceFiles() {
    return isBrowserRuntime() ? [...BROWSER_SKETCH_SOLVER_FIXTURE_TEST_SOURCES] : [];
}

async function test_browser_skip_metadata_for_local_file_tests() {
    let localFileTestRan = false;
    const localFileTest = {
        test: async function browserSkipLocalFileFixture() {
            localFileTestRan = true;
        },
        requiresLocalFiles: true,
    };

    const nodeReason = getTestSkipReason(localFileTest, { runtime: 'node' });
    if (nodeReason) {
        throw new Error(`Expected requiresLocalFiles tests to run in Node, got skip reason: ${nodeReason}`);
    }

    const browserReason = getTestSkipReason(localFileTest, { runtime: 'browser' });
    if (browserReason !== BROWSER_LOCAL_FILE_SKIP_REASON) {
        throw new Error(`Expected browser local-file skip reason, got: ${browserReason || '<none>'}`);
    }

    const browserResult = await runSingleTest(localFileTest, new PartHistory(), {
        runtime: 'browser',
        validateSolidVolumes: false,
    });
    if (!isSkippedTestResult(browserResult)) {
        throw new Error('Expected runSingleTest to return a skipped result for browser local-file tests.');
    }
    if (localFileTestRan) {
        throw new Error('Expected browser-skipped local-file test body not to run.');
    }

    const customSkipReason = getTestSkipReason({
        test: async function browserSkipCustomReason() { },
        skipInBrowser: 'Custom browser-only skip.',
    }, { runtime: 'browser' });
    if (customSkipReason !== 'Custom browser-only skip.') {
        throw new Error(`Expected custom browser skip reason, got: ${customSkipReason || '<none>'}`);
    }

    const sourceFileReason = getTestSkipReason({
        test: async function browserSkipSourceFile() { },
        _sourceFile: 'src/tests/partFiles/example.json',
    }, { runtime: 'browser' });
    if (sourceFileReason !== BROWSER_LOCAL_FILE_SKIP_REASON) {
        throw new Error(`Expected _sourceFile tests to skip in browser, got: ${sourceFileReason || '<none>'}`);
    }

    const solidGeneratingReason = getTestSkipReason({
        test: async function browserRunnableSolidGenerator() { },
        printArtifacts: false,
        exportFaces: true,
        exportSolids: true,
        resetHistory: true,
    }, { runtime: 'browser' });
    if (solidGeneratingReason) {
        throw new Error(`Expected solid-generating tests to remain runnable in browser, got skip reason: ${solidGeneratingReason}`);
    }

    const fixtureBackedTests = [
        'test_remesh_simplify_imported_fixture_stl',
        'test_import3d_fixture_merges_faces_4_and_34',
        'test_extrude_intersect_coplanar_face_merge',
        'test_fillet_angle',
        'test_fillet_edge_degenerate_segment',
        'test_sketch_profile_tolerant_loop_join',
        'test_fillet_compound_snapshot_resolution',
        'test_fillet_preserves_original_face_names',
        'test_fillet_face_names_and_merge_metadata_survive_native_manifold_rebuild',
    ];
    for (const testName of fixtureBackedTests) {
        const registeredTest = testFunctions.find((entry) => getTestName(entry) === testName);
        if (!registeredTest) {
            throw new Error(`Expected local-file test ${testName} to be registered.`);
        }
        const reason = getTestSkipReason(registeredTest, { runtime: 'browser' });
        if (reason !== BROWSER_LOCAL_FILE_SKIP_REASON) {
            throw new Error(`Expected ${testName} to skip in browser for local files, got: ${reason || '<none>'}`);
        }
    }

    const browserRunnableSolidSmokeTests = [
        'test_ExtrudeFace',
        'test_revolve_generates_manifold_native_faces_for_axis_edge_profile',
        'test_primitiveCube',
    ];
    for (const testName of browserRunnableSolidSmokeTests) {
        const registeredTest = testFunctions.find((entry) => getTestName(entry) === testName);
        if (!registeredTest) {
            throw new Error(`Expected browser-runnable solid test ${testName} to be registered.`);
        }
        const reason = getTestSkipReason(registeredTest, { runtime: 'browser' });
        if (reason) {
            throw new Error(`Expected ${testName} to remain runnable in browser, got skip reason: ${reason}`);
        }
    }

    const unexpectedlySkippedSolidTests = testFunctions
        .filter((entry) => !!(entry?.printArtifacts || entry?.exportFaces || entry?.exportSolids))
        .filter((entry) => !getBrowserLocalFileSkipReason(entry))
        .map((entry) => ({
            name: getTestName(entry),
            reason: getTestSkipReason(entry, { runtime: 'browser' }),
        }))
        .filter((entry) => entry.reason);
    if (unexpectedlySkippedSolidTests.length > 0) {
        const details = unexpectedlySkippedSolidTests
            .map((entry) => `${entry.name}: ${entry.reason}`)
            .join('; ');
        throw new Error(`Expected solid-generating tests without local-file requirements to remain runnable in browser. ${details}`);
    }

    const unmarkedFixtureReadTest = {
        test: async function browserSkipUnmarkedFixtureRead() {
            const err: any = new Error('ENOENT: no such file or directory, /src/tests/partFiles/missing_fixture.json');
            err.code = 'ENOENT';
            throw err;
        },
    };
    const unmarkedFixtureReadResult = await runSingleTest(unmarkedFixtureReadTest, new PartHistory(), {
        runtime: 'browser',
        validateSolidVolumes: false,
    });
    if (!isSkippedTestResult(unmarkedFixtureReadResult)) {
        throw new Error('Expected unmarked browser local fixture read failures to be reported as skipped.');
    }
}

function getPartFileImportTestName(filePath) {
    const file = path.basename(filePath);
    const baseName = String(file).replace(/\.[^.]+$/, '');
    const safeName = baseName.replace(/[^a-zA-Z0-9._-]+/g, '_').substring(0, 100);
    return `import_part_${safeName}`;
}

function sanitizeDiscoveredTestName(value, fallback = 'fixture') {
    const raw = String(value || '').trim();
    if (!raw) return fallback;
    const cleaned = raw
        .toLowerCase()
        .replace(/[^a-z0-9._-]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 120);
    return cleaned || fallback;
}

function getSketchSolverFixtureTestName(filePath, index = 0) {
    const file = path.basename(filePath);
    const base = String(file).replace(/\.[^.]+$/, '');
    const name = sanitizeDiscoveredTestName(base, `fixture_${index}`);
    return `test_sketch_solver_fixture_${name}`;
}

function createBrowserSkippedDiscoveredTest({ testName, sourceFile, exportFaces = false, exportSolids = false, allowErrors = false }) {
    const testFn = async function browserSkippedDiscoveredTest() { };
    try { Object.defineProperty(testFn, 'name', { value: testName, configurable: true }); } catch { /* ignore generated test name patch failure */ }
    return {
        test: testFn,
        afterRun: null,
        printArtifacts: false,
        exportFaces,
        exportSolids,
        resetHistory: true,
        allowErrors,
        skipInBrowser: BROWSER_LOCAL_FILE_SKIP_REASON,
        requiresLocalFiles: true,
        _sourceFile: sourceFile,
    };
}

function hasRegisteredTest(testName, sourceFile) {
    return testFunctions.some((testFunction) => (
        getTestName(testFunction) === testName
        || (sourceFile && testFunction?._sourceFile === sourceFile)
    ));
}

function registerBrowserDiscoveredSkipTests() {
    if (!isBrowserRuntime()) return;

    for (const filePath of getBrowserPartFileSourceFiles()) {
        const testName = getPartFileImportTestName(filePath);
        if (hasRegisteredTest(testName, filePath)) continue;
        testFunctions.push(createBrowserSkippedDiscoveredTest({
            testName,
            sourceFile: filePath,
            exportFaces: true,
            exportSolids: true,
            allowErrors: true,
        }));
    }

    const fixtureFiles = getBrowserSketchSolverFixtureSourceFiles();
    fixtureFiles.forEach((filePath, index) => {
        const testName = getSketchSolverFixtureTestName(filePath, index);
        if (hasRegisteredTest(testName, filePath)) return;
        testFunctions.push(createBrowserSkippedDiscoveredTest({
            testName,
            sourceFile: filePath,
        }));
    });
}

export function getTestSkipReason(testFunction: any, options: any = {}) {
    const runtime = options.runtime || (isBrowserRuntime() ? 'browser' : 'node');
    const skip = testFunction?.skip;
    if (typeof skip === 'function') {
        const reason = skip({ runtime, testFunction, options });
        if (reason) return reason === true ? 'Skipped by test configuration.' : String(reason);
    } else if (skip) {
        return skip === true ? 'Skipped by test configuration.' : String(skip);
    }
    if (runtime === 'browser') {
        const browserSkipReason = normalizeSkipReason(testFunction?.skipInBrowser, 'Skipped in browser test runner.');
        if (browserSkipReason) return browserSkipReason;

        const localFileSkipReason = getBrowserLocalFileSkipReason(testFunction);
        if (localFileSkipReason) return localFileSkipReason;
    }
    return '';
}

export function isSkippedTestResult(value) {
    return !!(value && typeof value === 'object' && value.skipped === true);
}

function skippedTestResult(reason) {
    return Object.freeze({
        skipped: true,
        reason: String(reason || 'Skipped by test configuration.'),
    });
}

function getTestName(testFunction) {
    return (testFunction?.test?.name && String(testFunction.test.name)) || 'unnamed_test';
}

function getCliRequestedTestName(argv = []) {
    const args = argv.slice(2);
    for (let i = 0; i < args.length; i += 1) {
        const arg = args[i];
        if (arg === '--test' || arg === '-t') {
            return args[i + 1] ? String(args[i + 1]) : '';
        }
        if (arg.startsWith('--test=')) {
            return arg.slice('--test='.length);
        }
        if (!arg.startsWith('-')) {
            return arg;
        }
    }
    return null;
}

function getRequestedTestFunctions(testFunctionsToSearch, requestedTestName) {
    if (requestedTestName == null) return testFunctionsToSearch;
    if (!requestedTestName) throw new Error('Missing test name. Use `pnpm test -- <test_name>` or `pnpm test -- --test <test_name>`.');

    const matchingTests = testFunctionsToSearch.filter(testFunction => getTestName(testFunction) === requestedTestName);
    if (matchingTests.length > 0) return matchingTests;

    const availableNames = testFunctionsToSearch.map(getTestName).sort();
    const suggestions = availableNames.filter(name => name.includes(requestedTestName)).slice(0, 10);
    const suggestionText = suggestions.length
        ? `\nMatching test names:\n${suggestions.map(name => `  - ${name}`).join('\n')}`
        : `\nNo matching test names found.`;
    throw new Error(`Unknown test "${requestedTestName}".${suggestionText}`);
}


export const testFunctions: any[] = [
    { test: test_file_manager_missing_model_rejects_without_alert, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_browser_skip_metadata_for_local_file_tests, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_cppNative_prepareManifoldMesh_matches_legacy_js_reference, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_cppSolidCore_preserves_face_ids_and_metadata, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_cppSolidCore_setAuthoringState_and_bakeTransform, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_cppSolidCore_weldVerticesByEpsilon_aligns_authoring_points_without_compacting_buffers, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_cppSolidCore_weldVerticesByEpsilon_aligns_neighboring_cells_by_true_distance, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_cppSolidCore_pushFace_moves_vertices_for_face, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_cppSolidCore_prepareManifoldMesh_repairs_orientation, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_cppSolidCore_topologyQueries_return_native_face_and_edge_payloads, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_cppSolidCore_boundaryQueries_match_geometric_edges_on_split_authoring_mesh, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_cppSolidCore_removeDisconnectedIslandsByVolume_drops_small_shells, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_cppSolidBakeTransform_updates_solid_authoring_state, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_cppSolidMirror_preserves_face_metadata, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_revolve_face_profile_boundary_recovery_marks_inner_loop_as_hole, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_revolve_feature_resolves_face_and_edge_string_references, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_revolve_axis_edge_profile_reuses_axis_vertices_for_partial_sweep, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_revolve_generates_manifold_native_faces_for_axis_edge_profile, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_revolve_restored_consumed_sketch_keeps_edge_sidewalls_after_angle_edit, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_remesh_simplify_uses_kernel_simplify_without_full_tolerance_weld, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    {
        test: test_remesh_simplify_imported_fixture_stl,
        afterRun: afterRun_remesh_simplify_imported_fixture_stl,
        printArtifacts: false,
        exportFaces: false,
        exportSolids: false,
        resetHistory: true,
        requiresLocalFiles: true,
        _sourceFile: 'src/tests/importTestingData/import_test.stl',
    },
    { test: test_self_intersection_cleanup_feature_splits_selected_solid, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_self_intersection_cleanup_feature_context_button_for_single_solid, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_self_intersection_cleanup_feature_is_available_in_modeling_and_surfacing, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_solid_simplify_preserves_face_tags_and_metadata, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_revolve_after_union_preserves_face_reference_resolution, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_cppSolidNative_setEpsilon_welds_vertices, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_cppSolidNative_setEpsilon_merges_cell_boundary_pair_and_rebuilds_manifold, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_cppSolidNative_cleanupTinyFaceIslands_reassigns_small_face_and_prunes_metadata, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_cppSolidNative_removeSmallIslands_drops_external_shell_and_prunes_metadata, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_cppSolidNative_mergeTinyFaces_merges_small_adjacent_face, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_cppSolidNative_removeInternalTriangles_preserves_clean_manifold_shell, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_cppSolidNative_pushFace_updates_planar_face_vertices, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_cppSolidNative_deduplicateFaceNames_reassigns_duplicate_triangles_to_first_id, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_cppSolidNative_getFaceNormal_reports_planar_face_normal, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_cppSolidNative_manifoldize_repairs_incoherent_winding, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_cppSolidNative_classifyFilletEdgeDirection_cubeConvexEdge_isInset, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_cppSolidNative_booleanCombinedAuthoringState_preserves_face_names_and_metadata, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_cppSolidNative_booleanResults_apply_fixed_post_weld_epsilon, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_cppSolidNative_buildFilletEdgeAuthoringState_returns_standard_edge_snapshots, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_cppSolidNative_filletEdge_inflate_offsets_edge_wedge_corner_in_both_tangent_directions, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_cppSolidNative_filletEdge_finalSnapshot_preserves_face_names_and_metadata, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_cppSolidNative_filletEdge_nudgeFaceDistance_moves_only_end_cap_vertices, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_cppSolidNative_postBoolean_fillet_merges_coplanar_cube_end_caps, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_cppSolidNative_solidFillet_preserves_tube_centerline_aux_edge, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_cppSolidNative_postBoolean_fillet_reverse_end_cap_nudge_requires_merge, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_cppSolidNative_mergeCoplanarAdjacentFilletEndCaps_retags_triangles_to_planar_neighbor, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_cppSolidNative_reversePostBooleanFilletEndCapNudge_skips_faces_that_share_vertices_with_fillet_sidewalls, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_cppSolidNative_reassignTinyFilletSidewallSliverTriangles_merges_triangle_whose_vertices_lie_on_single_planar_face_boundary, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_cppSolidNative_collapseFilletSideWallFaces_collapses_strip_vertices, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_cppSolidNative_collapseFilletSideWallFaces_collapses_away_from_round_face, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_cppSolidNative_collapseFilletSideWallFaces_moves_shared_endcap_edge_vertices, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_cppSolidNative_collapseFilletSideWallFaces_preserves_shared_endpoint_junctions, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_cppTube_open_tube_preserves_expected_face_labels, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_cppTube_closed_hollow_tube_preserves_expected_face_labels, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_cppTube_union_preserves_distinct_face_labels_across_native_snapshots, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_cppTube_slow_fallback_union_preserves_external_cap_label, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_cppTube_native_builder_reports_selected_build_mode, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_cppTube_native_auto_falls_back_to_slow_on_foldback_path, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_cppTube_feature_inner_cutter_nudges_open_end_caps, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_cppPrimitive_cube_preserves_expected_face_labels, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_cppPrimitive_cylinder_preserves_expected_face_labels_and_metadata, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_cppPrimitive_cone_preserves_expected_face_labels_and_metadata, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_cppPrimitive_torus_and_pyramid_preserve_face_labels, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_cppPrimitive_sphere_preserves_single_face_label, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_configurator_expressions, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_manifoldPlus_sum, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_plane, printArtifacts: false, exportFaces: true, exportSolids: true, resetHistory: true },
    { test: test_primitiveCube, printArtifacts: false, exportFaces: true, exportSolids: true, resetHistory: true },
    { test: test_primitivePyramid, printArtifacts: false, exportFaces: true, exportSolids: true, resetHistory: true },
    { test: test_primitiveCylinder, printArtifacts: false, exportFaces: true, exportSolids: true, resetHistory: true },
    { test: test_face_source_feature_seed, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_mesh_cleanup_split_crossing_triangles_inserts_intersection_edges, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_mesh_cleanup_split_point_intersection_inserts_vertex, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_mesh_cleanup_split_then_winding_removes_internal_overlap, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_mesh_cleanup_find_one_triangle_intersected_by_multiple_triangles, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_mesh_cleanup_two_cut_segments_cross_inside_same_triangle, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_mesh_cleanup_intersection_endpoint_on_shared_mesh_edge, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_mesh_cleanup_detects_coplanar_partial_triangle_overlap, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_mesh_cleanup_removes_geometrically_duplicate_triangles, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_mesh_cleanup_removes_closed_box_completely_inside_another, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_mesh_cleanup_overlapping_boxes_volume_equals_union, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_mesh_cleanup_disjoint_closed_boxes_are_preserved, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_mesh_cleanup_preserves_face_ids_after_splitting, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_mesh_cleanup_complete_operation_is_idempotent, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    {
        test: test_offsetFace_preserves_individual_edges,
        afterRun: afterRun_offsetFace_preserves_individual_edges,
        printArtifacts: false,
        exportFaces: false,
        exportSolids: false,
        resetHistory: true,
    },
    { test: test_face_thicken_planar_profile, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_face_thicken_hole_profile, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_face_thicken_curved_cylinder_side, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_face_thicken_partial_torus_side_avoids_internal_voids, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_face_thicken_boundary_uses_smooth_adjacent_face_normals, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_face_thicken_connected_patch_preserves_source_cap_faces, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_face_thicken_groups_curved_patch_by_shared_edge_normals, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_face_thicken_selected_adjacent_normals_accept_relaxed_angle_threshold, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_face_thicken_selected_adjacent_normals_match_shared_offset_edge, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_face_thicken_filleted_planar_face_keeps_clean_boundaries, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_face_thicken_self_overlap_cylinder_side, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    {
        test: test_thicken_sphere_torus_union,
        afterRun: afterRun_thicken_sphere_torus_union,
        printArtifacts: false,
        exportFaces: false,
        exportSolids: false,
        resetHistory: true,
    },
    {
        test: test_offsetShell_thickens_all_faces_except_selected,
        afterRun: afterRun_offsetShell_thickens_all_faces_except_selected,
        printArtifacts: false,
        exportFaces: false,
        exportSolids: false,
        resetHistory: true,
    },
    {
        test: test_offsetShell_negative_distance_rounds_unselected_solid_edges,
        afterRun: afterRun_offsetShell_negative_distance_rounds_unselected_solid_edges,
        printArtifacts: false,
        exportFaces: false,
        exportSolids: false,
        resetHistory: true,
    },
    { test: test_offsetShell_negative_distance_skips_edges_without_union_sidewall, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_offsetShell_area_loss_sidewall_reassigns_to_dominant_neighbor, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_offsetShell_area_loss_sidewall_reassign_preserves_source_sidewall_end_cap, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_offsetShell_area_loss_sidewall_reassign_skips_protected_open_face_neighbor, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_offsetShell_pipe_sliver_collapse_falls_back_to_shortest_edge, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_offsetShell_pipe_sliver_collapse_moves_only_pipe_vertices, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    {
        test: test_offsetShell_repro_20260607082324_removes_area_loss_sidewall,
        afterRun: afterRun_offsetShell_repro_20260607082324_removes_area_loss_sidewall,
        printArtifacts: false,
        exportFaces: false,
        exportSolids: false,
        resetHistory: true,
    },
    {
        test: test_offsetShell_repro_20260608054724_reassign_preserves_g3_end_and_start_end_faces,
        afterRun: afterRun_offsetShell_repro_20260608054724_reassign_preserves_g3_end_and_start_end_faces,
        printArtifacts: false,
        exportFaces: false,
        exportSolids: false,
        resetHistory: true,
    },
    {
        test: test_offsetShell_debug_separates_rounded_tube_remainder,
        afterRun: afterRun_offsetShell_debug_separates_rounded_tube_remainder,
        printArtifacts: false,
        exportFaces: false,
        exportSolids: false,
        resetHistory: true,
    },
    { test: test_offsetShell_preserves_source_centerlines, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_thicken_feature_is_available_in_modeling_and_surfacing_workbenches, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    {
        test: test_thicken_feature_serializes_and_replays_planar_profile,
        afterRun: afterRun_thicken_feature_serializes_and_replays_planar_profile,
        printArtifacts: false,
        exportFaces: false,
        exportSolids: false,
        resetHistory: true,
    },
    {
        test: test_thicken_feature_multiple_faces_produce_multiple_solids,
        afterRun: afterRun_thicken_feature_multiple_faces_produce_multiple_solids,
        printArtifacts: false,
        exportFaces: false,
        exportSolids: false,
        resetHistory: true,
    },
    {
        test: test_thicken_feature_connected_faces_remain_individual_solids,
        afterRun: afterRun_thicken_feature_connected_faces_remain_individual_solids,
        printArtifacts: false,
        exportFaces: false,
        exportSolids: false,
        resetHistory: true,
    },
    { test: test_face_id_repair_uses_metadata_roles_without_name_suffixes, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_face_id_repair_accepts_feature_scoped_metadata_roles, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_solid_face_queries_fall_back_to_authoring_arrays_for_non_manifold_meshes, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_visualize_does_not_repair_face_ids, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_primitiveCone, printArtifacts: false, exportFaces: true, exportSolids: true, resetHistory: true },
    { test: test_primitiveTorus, afterRun: afterRun_primitiveTorus, printArtifacts: false, exportFaces: true, exportSolids: true, resetHistory: true },
    { test: test_primitiveSphere, printArtifacts: false, exportFaces: true, exportSolids: true, resetHistory: true },
    { test: test_feature_dimension_overlay_supports_port, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_feature_dimension_registry_support_and_transform_toggle_agree, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_feature_dimension_annotation_builder_dispatches_registered_primitive, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_feature_dimension_annotation_builder_dispatches_pattern, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_reference_snapshot_store_uses_generic_reference_snapshots_key, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_feature_dimension_effect_reference_resolves_consumed_profile_and_axis, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_part_history_prevent_remove_survives_multi_child_scene_clear, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_transform_control_scene_binding_readds_and_removes_overlay_roots, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_port_extension_annotation_geometry_preserves_extension_value, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_transform_reference_sanitize_preserves_metadata, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_transform_reference_base_uses_face_pick_point, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_referenced_transform_matrix_uses_vertex_reference_origin, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_port_definition_uses_transform_reference_without_anchor, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_port_definition_uses_transform_reference_and_direction_reference, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_boolean_subtract, printArtifacts: false, exportFaces: true, exportSolids: true, resetHistory: true },
    { test: test_boolean_face_metadata_preserved, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    {
        test: test_primitive_boolean_union_preserves_face_grouping,
        afterRun: afterRun_primitive_boolean_union_preserves_face_grouping,
        printArtifacts: false,
        exportFaces: false,
        exportSolids: false,
        resetHistory: true,
    },
    {
        test: test_boolean_operation_target_name_preserved,
        afterRun: afterRun_boolean_operation_target_name_preserved,
        printArtifacts: false,
        exportFaces: true,
        exportSolids: true,
        resetHistory: true,
    },
    { test: test_stlLoader, printArtifacts: false, exportFaces: true, exportSolids: true, resetHistory: true },
    {
        test: test_import3d_decimation_reduces_triangle_count,
        afterRun: afterRun_import3d_decimation_reduces_triangle_count,
        printArtifacts: false,
        exportFaces: true,
        exportSolids: true,
        resetHistory: true,
    },
    {
        test: test_import3d_decimation_reapplies_from_cached_source_mesh,
        afterRun: afterRun_import3d_decimation_reapplies_from_cached_source_mesh,
        printArtifacts: false,
        exportFaces: true,
        exportSolids: true,
        resetHistory: true,
    },
    {
        test: test_import3d_decimation_99_is_near_full_detail,
        afterRun: afterRun_import3d_decimation_99_is_near_full_detail,
        printArtifacts: false,
        exportFaces: true,
        exportSolids: true,
        resetHistory: true,
    },
    {
        test: test_import3d_decimation_100_restores_original_geometry,
        afterRun: afterRun_import3d_decimation_100_restores_original_geometry,
        printArtifacts: false,
        exportFaces: true,
        exportSolids: true,
        resetHistory: true,
    },
    {
        test: test_import3d_decimation_seeds_source_snapshot_for_legacy_cache,
        afterRun: afterRun_import3d_decimation_seeds_source_snapshot_for_legacy_cache,
        printArtifacts: false,
        exportFaces: true,
        exportSolids: true,
        resetHistory: true,
    },
    {
        test: test_import3d_decimation_preserves_source_snapshot_without_json_clone,
        afterRun: afterRun_import3d_decimation_preserves_source_snapshot_without_json_clone,
        printArtifacts: false,
        exportFaces: true,
        exportSolids: true,
        resetHistory: true,
    },
    {
        test: test_import3d_planar_extraction_merges_sliver_bridge,
        afterRun: afterRun_import3d_planar_extraction_merges_sliver_bridge,
        printArtifacts: false,
        exportFaces: true,
        exportSolids: true,
        resetHistory: true,
    },
    {
        test: test_import3d_planar_extraction_keeps_small_flat_patch_edges,
        printArtifacts: false,
        exportFaces: false,
        exportSolids: false,
        resetHistory: true,
    },
    {
        test: test_import3d_planar_extraction_merges_near_coplanar_patch_back_into_neighbor,
        printArtifacts: false,
        exportFaces: false,
        exportSolids: false,
        resetHistory: true,
    },
    {
        test: test_import3d_fixture_merges_faces_4_and_34,
        printArtifacts: false,
        exportFaces: false,
        exportSolids: false,
        resetHistory: true,
        requiresLocalFiles: true,
        _sourceFile: 'src/tests/importTestingData/import_test.stl',
    },
    {
        test: test_import3d_extract_multiple_solids_toggle,
        afterRun: afterRun_import3d_extract_multiple_solids_toggle,
        printArtifacts: false,
        exportFaces: true,
        exportSolids: true,
        resetHistory: true,
    },
    { test: test_SweepFace, printArtifacts: false, exportFaces: true, exportSolids: true, resetHistory: true },
    {
        test: test_SweepFace_pathAlign_multi_loop_islands,
        afterRun: afterRun_sweepFace_pathAlign_multi_loop_islands,
        printArtifacts: false,
        exportFaces: true,
        exportSolids: true,
        resetHistory: true,
    },
    { test: test_tube, printArtifacts: false, exportFaces: true, exportSolids: true, resetHistory: true },
    { test: test_tube_closedLoop, printArtifacts: false, exportFaces: true, exportSolids: true, resetHistory: true },
    { test: test_wire_harness_formboard_reuses_only_formboard_sheet, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_wire_harness_connection_endpoint_resolution, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_sheet_custom_size_persists, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_sheet_metadata_updated_at_is_stable_on_read, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_pmi_view_text_size_setting_normalizes, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_pmi_view_visibility_state_normalizes, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_pmi_view_visibility_state_round_trip, afterRun: afterRun_pmi_view_visibility_state_round_trip, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_pmi_linear_dimension_face_target_measures_perpendicular_to_face, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_pmi_linear_dimension_parallel_faces_measure_plane_spacing, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_pmi_linear_dimension_face_extensions_can_jog_to_measurement_line, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_pmi_linear_dimension_edge_target_measures_perpendicular_to_edge, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_pmi_linear_dimension_parallel_edges_measure_perpendicular_spacing, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_pmi_linear_dimension_single_edge_still_measures_edge_length, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_pmi_linear_dimension_limits_targets_to_two, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_pmi_annotation_failure_status_is_visible, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_pmi_radial_dimension_accepts_pipe_aux_path_face, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_pmi_radial_dimension_uses_fillet_pipe_radius_override, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_pmi_radial_dimension_uses_offset_shell_pipe_radius_override, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_pmi_monochrome_label_svg_uses_backdrop_color, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_pmi_monochrome_label_layout_is_tighter_than_shaded, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_pmi_enter_edit_mode_reuses_shared_flow, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_pmi_export_render_context_applies_visibility_state, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_pmi_effective_visibility_respects_hidden_ancestor, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_sheet_clipboard_image_utils, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_wire_harness_formboard_insert, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_wire_harness_sheet_table_insert, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_wire_harness_infers_endpoint_side_from_spline_direction, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_wire_harness_routes_render_as_scene_solids, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_wire_harness_route_results_persist_in_model_json, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_sketch_openLoop, afterRun: afterRun_sketch_openLoop, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_sketch_snapshot_restore_selection_handlers, afterRun: afterRun_sketch_snapshot_restore_selection_handlers, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    {
        test: test_sketch_face_attachment_alignment,
        afterRun: afterRun_sketch_face_attachment_alignment,
        printArtifacts: false,
        exportFaces: false,
        exportSolids: false,
        resetHistory: true,
    },
    { test: test_sketch_solver_topology_rect_shared_points, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_sketch_solver_topology_coincident_chain, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_sketch_solver_topology_coincident_loop_no_flip, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_sketch_solver_topology_rect_round_trip_sequence, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_sketch_solver_topology_coincident_chain_multi_step, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_sketch_solver_distance_slide_large_drop_settles_single_solve, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_sketch_solver_line_to_point_distance_constraint, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    {
        test: test_extrude_negative_distance_cap_alignment,
        afterRun: afterRun_extrude_negative_distance_cap_alignment,
        printArtifacts: false,
        exportFaces: true,
        exportSolids: true,
        resetHistory: true,
    },
    {
        test: test_extrude_intersect_coplanar_face_merge,
        afterRun: afterRun_extrude_intersect_coplanar_face_merge,
        printArtifacts: false,
        exportFaces: false,
        exportSolids: false,
        resetHistory: true,
        requiresLocalFiles: true,
        _sourceFile: 'src/tests/partFiles/slowsketch.json',
    },
    { test: test_ExtrudeFace, printArtifacts: false, exportFaces: true, exportSolids: true, resetHistory: true },
    {
        test: test_extrude_solid_face_uses_boundary_edge_sidewalls,
        afterRun: afterRun_extrude_solid_face_uses_boundary_edge_sidewalls,
        printArtifacts: false,
        exportFaces: false,
        exportSolids: false,
        resetHistory: true,
    },
    { test: test_Fillet, printArtifacts: false, exportFaces: true, exportSolids: true, resetHistory: true },
    {
        test: test_fillet_angle,
        afterRun: afterRun_fillet_angle,
        printArtifacts: false,
        exportFaces: false,
        exportSolids: false,
        resetHistory: true,
        requiresLocalFiles: true,
        _sourceFile: 'src/tests/partFiles/fillet_angle_test.BREP.json',
    },
    {
        test: test_fillet_corner_bridge,
        afterRun: afterRun_fillet_corner_bridge,
        printArtifacts: false,
        exportFaces: true,
        exportSolids: true,
        resetHistory: true,
    },
    {
        test: test_fillet_rebuild_re_resolves_stale_edge_object,
        printArtifacts: false,
        exportFaces: false,
        exportSolids: false,
        resetHistory: true,
    },
    {
        test: test_history_delete_restores_removed_upstream_solid_from_source_feature,
        printArtifacts: false,
        exportFaces: false,
        exportSolids: false,
        resetHistory: true,
    },
    {
        test: test_reference_selection_timestamp_scope_preserves_unchanged_edge_cache,
        printArtifacts: false,
        exportFaces: false,
        exportSolids: false,
        resetHistory: true,
    },
    {
        test: test_fillet_cache_invalidates_when_target_solid_changes_away_from_selected_edges,
        printArtifacts: false,
        exportFaces: false,
        exportSolids: false,
        resetHistory: true,
    },
    {
        test: test_fillet_edge_degenerate_segment,
        afterRun: afterRun_fillet_edge_degenerate_segment,
        printArtifacts: false,
        exportFaces: false,
        exportSolids: false,
        resetHistory: true,
        requiresLocalFiles: true,
        _sourceFile: 'src/tests/partFiles/fillet_test.BREP.json',
    },
    {
        test: test_sketch_profile_tolerant_loop_join,
        afterRun: afterRun_sketch_profile_tolerant_loop_join,
        printArtifacts: false,
        exportFaces: false,
        exportSolids: false,
        resetHistory: true,
        requiresLocalFiles: true,
        _sourceFile: 'src/tests/partFiles/slowsketch.json',
    },
    {
        test: test_fillet_compound_snapshot_resolution,
        afterRun: afterRun_fillet_compound_snapshot_resolution,
        printArtifacts: false,
        exportFaces: false,
        exportSolids: false,
        resetHistory: true,
        requiresLocalFiles: true,
        _sourceFile: 'src/tests/partFiles/slowsketch.json',
    },
    {
        test: test_fillet_generated_history_20260321144106,
        afterRun: afterRun_fillet_generated_history_20260321144106,
        printArtifacts: false,
        exportFaces: false,
        exportSolids: false,
        resetHistory: true,
    },
    {
        test: test_generated_history_20260709065543,
        afterRun: afterRun_generated_history_20260709065543,
        printArtifacts: false,
        exportFaces: false,
        exportSolids: false,
        resetHistory: true,
    },
    {
        test: test_generated_history_20260709065543_base_thickness,
        afterRun: afterRun_generated_history_20260709065543,
        printArtifacts: false,
        exportFaces: false,
        exportSolids: false,
        resetHistory: true,
    },
    {
        test: test_generated_history_20260322220620,
        afterRun: afterRun_generated_history_20260322220620,
        printArtifacts: false,
        exportFaces: false,
        exportSolids: false,
        resetHistory: true,
    },
    {
        test: test_generated_history_20260322222832,
        afterRun: afterRun_generated_history_20260322222832,
        printArtifacts: false,
        exportFaces: false,
        exportSolids: false,
        resetHistory: true,
    },
    {
        test: test_generated_history_20260418030116,
        afterRun: afterRun_generated_history_20260418030116,
        printArtifacts: false,
        exportFaces: false,
        exportSolids: false,
        resetHistory: true,
    },
    {
        test: test_generated_history_20260427005357,
        afterRun: afterRun_generated_history_20260427005357,
        printArtifacts: false,
        exportFaces: false,
        exportSolids: false,
        resetHistory: true,
    },
    {
        test: test_generated_history_20260427005357_three_face_thicken,
        afterRun: afterRun_generated_history_20260427005357_three_face_thicken,
        printArtifacts: false,
        exportFaces: false,
        exportSolids: false,
        resetHistory: true,
    },
    {
        test: test_generated_history_20260427005357_nine_face_thicken,
        afterRun: afterRun_generated_history_20260427005357_nine_face_thicken,
        printArtifacts: false,
        exportFaces: false,
        exportSolids: false,
        resetHistory: true,
    },
    {
        test: test_generated_history_20260523000414,
        printArtifacts: false,
        exportFaces: false,
        exportSolids: false,
        resetHistory: true,
    },
    {
        test: test_generated_history_20260531201126,
        printArtifacts: false,
        exportFaces: false,
        exportSolids: false,
        resetHistory: true,
    },
    {
        test: test_generated_history_20260606004152,
        printArtifacts: false,
        exportFaces: false,
        exportSolids: false,
        resetHistory: true,
    },
    {
        test: test_generated_history_20260607180752_offset_shell_negative_half_is_manifold,
        printArtifacts: false,
        exportFaces: false,
        exportSolids: false,
        resetHistory: true,
    },
    {
        test: test_generated_history_20260607180752_offset_shell_negative_one_keeps_cleanup,
        printArtifacts: false,
        exportFaces: false,
        exportSolids: false,
        resetHistory: true,
    },
    {
        test: test_generated_history_20260607180752_offset_shell_cleanup_toggles_disable_pipe_collapse,
        printArtifacts: false,
        exportFaces: false,
        exportSolids: false,
        resetHistory: true,
    },
    {
        test: test_generated_history_20260709035143_offset_shell_prefers_source_face_names,
        printArtifacts: false,
        exportFaces: false,
        exportSolids: false,
        resetHistory: true,
    },
    {
        test: test_generated_history_20260612230031,
        afterRun: afterRun_generated_history_20260612230031,
        printArtifacts: false,
        exportFaces: false,
        exportSolids: false,
        resetHistory: true,
    },
    {
        test: test_generated_history_20260612232755,
        afterRun: afterRun_generated_history_20260612232755,
        printArtifacts: false,
        exportFaces: false,
        exportSolids: false,
        resetHistory: true,
    },
    {
        test: test_generated_history_20260613000139,
        afterRun: afterRun_generated_history_20260613000139,
        printArtifacts: false,
        exportFaces: false,
        exportSolids: false,
        resetHistory: true,
    },
    {
        test: test_generated_history_20260613003952,
        afterRun: afterRun_generated_history_20260613003952,
        printArtifacts: false,
        exportFaces: false,
        exportSolids: false,
        resetHistory: true,
    },
    {
        test: test_fillet_preserves_original_face_names,
        afterRun: afterRun_fillet_preserves_original_face_names,
        printArtifacts: false,
        exportFaces: false,
        exportSolids: false,
        resetHistory: true,
        requiresLocalFiles: true,
        _sourceFile: 'src/tests/partFiles/medium_fillets.BREP.json',
    },
    {
        test: test_fillet_face_names_and_merge_metadata_survive_native_manifold_rebuild,
        afterRun: afterRun_fillet_face_names_and_merge_metadata_survive_native_manifold_rebuild,
        printArtifacts: false,
        exportFaces: false,
        exportSolids: false,
        resetHistory: true,
        requiresLocalFiles: true,
        _sourceFile: 'src/tests/partFiles/medium_fillets.BREP.json',
    },
    { test: test_Fillet_NonClosed, afterRun: afterRun_Fillet_NonClosed, printArtifacts: false, exportFaces: true, exportSolids: true, resetHistory: true },
    { test: test_fillets_more_dificult, printArtifacts: false, exportFaces: true, exportSolids: true, resetHistory: true },
    { test: test_Chamfer, printArtifacts: false, exportFaces: true, exportSolids: true, resetHistory: true },
    { test: test_cppChamfer_single_edge_builds_native_named_tool_and_result, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_cppChamfer_auto_direction_uses_native_classifier, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_cppChamfer_stabilizes_tiny_terminal_segments_before_offsetting, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_cppChamfer_bridges_nearly_tangent_adjacent_end_caps, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_cppChamfer_projects_open_end_caps_back_to_endpoint_plane, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_cppChamfer_debug_emits_cross_section_face_per_sample, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_cppChamfer_debug_sections_materialize_as_sketch_profiles, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_edge_smooth_curve_fit, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_edge_smooth_curve_fit_closed_loop, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_edge_smooth_constraints_prevent_triangle_foldback, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_edge_smooth_closed_loop_feature_selection, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_edge_smooth_whole_solid_selection, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_edge_smooth_face_selection, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_smooth_with_subdivision_replaces_source_solid, afterRun: afterRun_smooth_with_subdivision_replaces_source_solid, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_smooth_with_subdivision_preserves_centered_ring_symmetry, afterRun: afterRun_smooth_with_subdivision_preserves_centered_ring_symmetry, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_smooth_with_subdivision_preserves_mirrored_union_symmetry, afterRun: afterRun_smooth_with_subdivision_preserves_mirrored_union_symmetry, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_hole_through, afterRun: afterRun_hole_through, printArtifacts: false, exportFaces: true, exportSolids: true, resetHistory: true },
    { test: test_hole_countersink, afterRun: afterRun_hole_countersink, printArtifacts: false, exportFaces: true, exportSolids: true, resetHistory: true },
    { test: test_hole_counterbore, afterRun: afterRun_hole_counterbore, printArtifacts: false, exportFaces: true, exportSolids: true, resetHistory: true },
    { test: test_hole_multi_point_cloned_cutter, afterRun: afterRun_hole_multi_point_cloned_cutter, printArtifacts: false, exportFaces: true, exportSolids: true, resetHistory: true },
    { test: test_hole_thread_symbolic, afterRun: afterRun_hole_thread_symbolic, printArtifacts: false, exportFaces: true, exportSolids: true, resetHistory: true },
    { test: test_hole_thread_modeled, afterRun: afterRun_hole_thread_modeled, printArtifacts: false, exportFaces: true, exportSolids: true, resetHistory: true },
    { test: test_extrude_rectangle_profile_has_one_sidewall_per_sketch_edge, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_generated_history_20260609165436_six_edge_profile_has_six_sidewalls, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_feature_edge_name_resolution_prefers_boolean_result_over_raw_tool, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_run_history_calls_are_serialized, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_subtract_extrude_preserves_rectangle_tool_sidewall_faces, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_subtract_restore_rejects_raw_tool_added_snapshot, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_generated_history_20260609042734_preserves_s22_subtract_sidewalls, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_generated_history_20260609045351_fillet_expanded_replay_uses_subtract_result, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_generated_history_20260609074231_outset_fillet_end_caps_merge_into_planar_faces, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_generated_history_20260609150657_outset_fillet_start_end_caps_merge_into_planar_face, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_pushFace_feature, afterRun: afterRun_pushFace_feature, printArtifacts: false, exportFaces: true, exportSolids: true, resetHistory: true },
    { test: test_pushFace, afterRun: afterRun_pushFace, printArtifacts: false, exportFaces: true, exportSolids: true, resetHistory: true },
    { test: test_mirror, printArtifacts: false, exportFaces: true, exportSolids: true, resetHistory: true },
    { test: test_pattern_circular_count_pitch_uses_angle_as_step, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_history_features_basic, afterRun: afterRun_history_features_basic, printArtifacts: false, exportFaces: true, exportSolids: true, resetHistory: true },
    { test: test_history_expand_does_not_dirty, afterRun: afterRun_history_expand_does_not_dirty, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_history_test_snippet_persistent_data_allowlist, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_history_test_snippet_includes_cam_operations, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_history_test_snippet_toolbar_snapshot_compacts_cam_generated_data, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_history_test_snippet_omits_empty_cam_state, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_history_test_snippet_includes_global_cam_state_without_operations, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_selection_owning_feature_resolution, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_selection_line2_resolution_repair, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_selection_hover_material_restores_before_dispose, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_selection_profile_named_solid_face_hover_does_not_tint_shared_face_material, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_selection_sketch_hover_tints_material_in_place, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_selection_filter_empty_hover_clears_in_place_sketch_hover, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_solid_overlap_diagnostics_detects_coplanar_overlap, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_solid_overlap_diagnostics_ignores_boundary_touching_faces, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_solid_overlap_diagnostics_detects_cross_solid_overlap, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_boolean_overlap_conditioning_union_enabled_by_default, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_boolean_overlap_conditioning_union_can_be_disabled, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_boolean_overlap_conditioning_subtract_enabled_by_default, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_boolean_overlap_conditioning_subtract_expands_tool_entry_cap_outward, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_boolean_overlap_conditioning_subtract_can_be_disabled, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_boolean_overlap_conditioning_direct_api_enabled_by_default, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_boolean_overlap_conditioning_direct_api_can_be_disabled, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_cam_plan_manager_preserves_operations_and_profiles, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_cam_plan_manager_async_generation_reports_progress_steps, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_cam_plan_manager_strips_legacy_generated_data, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_cam_shadow_cutter_generated_history_20260704000935_keeps_outer_loop, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_generated_history_20260715000656, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_cam_shadow_cutter_cuts_each_loop_to_depth_before_next_loop, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_cam_shadow_cutter_generates_clear_hole_loop, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_cam_shadow_cutter_generates_outer_and_hole_for_nonconvex_profile, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_cam_shadow_cutter_history_item_generates_toolpath, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_cam_shadow_cutter_ignores_raised_cap_loops_as_holes, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_cam_shadow_cutter_offset_keeps_l_shape_inside_corner_clear, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_cam_shadow_cutter_offset_stays_outside_concave_shadow, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_cam_roughing_history_item_generates_sliced_toolpaths, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_cam_roughing_keeps_vertical_cutter_clear_of_overhangs, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_cam_roughing_debug_slices_emit_layer_solids, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_cam_roughing_debug_slices_create_real_scene_solids, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_cam_roughing_debug_slices_survive_combined_cam_plan, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_cam_roughing_sloped_slab_generates_each_step, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_cam_roughing_unions_curved_slice_shadow_before_pathing, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_cam_roughing_uses_each_slice_shadow, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_cam_roughing_vertical_wall_slice_matches_shadow_cutter_loop, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_cam_surfacing_adaptive_sampling_inserts_points_on_curved_face, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_cam_surfacing_applies_parent_transform_to_direct_face_geometry, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_cam_surfacing_both_raster_directions_emit_x_and_y_paths, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_cam_surfacing_clearance_link_samples_narrow_preserved_geometry, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_cam_surfacing_combined_gcode_posts_single_runnable_program, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_cam_surfacing_combined_gcode_reissues_feed_after_roughing, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_cam_surfacing_detects_narrow_preserved_island_between_coarse_samples, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_cam_surfacing_does_not_cut_across_selected_face_hole, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_cam_surfacing_does_not_duplicate_direct_face_with_owner_metadata, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_cam_surfacing_flat_path_tolerance_zero_respects_sample_spacing, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_cam_surfacing_history_item_generates_ball_endmill_raster, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_cam_surfacing_follows_sloped_face_with_drop_cutter, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_cam_surfacing_reaches_edge_beside_coplanar_preserved_face, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_cam_surfacing_reports_warning_when_raster_too_dense, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_cam_surfacing_resolves_solid_owned_face_reference, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_cam_surfacing_uses_explicit_solid_owner_for_shared_face_name, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_cam_surfacing_splits_runs_around_preserved_island, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_cam_surfacing_stops_before_higher_adjacent_preserved_face, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_cam_surfacing_stock_allowance_leaves_material_on_selected_face, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_cam_surfacing_ui_reference_metadata_preserves_shared_face_owner, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_cam_surfacing_uses_low_clearance_links_between_separate_face_spans, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_cam_surfacing_falls_back_to_full_retract_when_low_hop_reaches_safe_height, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_cam_surfacing_uses_userdata_solid_owner_for_shared_face_name, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_cam_surfacing_y_raster_reaches_selected_face_edges, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_cam_surfacing_zero_sample_spacing_uses_automatic_spacing, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_cam_surfacing_rejects_vertical_face_without_projected_area, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_cam_shadow_cutter_single_solid_does_not_require_target_selection, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_cam_toolpath_simulator_displays_ball_endmill_round_tip, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_cam_toolpath_simulator_visualizes_program_and_moves_head, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_cam_shadow_cutter_uses_projected_outline_not_convex_hull, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_cam_workbench_exit_clears_scene_artifacts, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_cam_workbench_registers_shadow_cutter_and_roughing_operations, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_cam_workbench_registers_and_persists_part_history_state, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_visibility_hidden_state_persistence, afterRun: afterRun_visibility_hidden_state_persistence, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_sketch_feature_scene_visibility, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_textToFace, afterRun: afterRun_textToFace, printArtifacts: false, exportFaces: true, exportSolids: false, resetHistory: true },
    { test: test_sheetMetal_nonManifold_sm_f18, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_sheetMetal_tab_circular_hole_wall, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_sheetMetal_flat_pattern_files_use_model_and_feature_names, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_sheetMetal_flat_pattern_preview_visualize_is_idempotent, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_sheetMetal_bend_face_cylindrical_metadata, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_sheetMetal_tab_and_flange_context_buttons, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_sheetMetal_cutout_preserves_multiple_profile_loops, afterRun: afterRun_sheetMetal_cutout_preserves_multiple_profile_loops, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_sheetMetal_cutout_context_button, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_sheetMetal_contour_flange_context_button_prefers_sketch, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_sheetMetal_contour_flange_whole_sketch_selection, afterRun: afterRun_sheetMetal_contour_flange_whole_sketch_selection, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_sheetMetal_cutoutEdge_flange_controls, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_sheetMetal_corner_fillet, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_sheetMetal_corner_fillet_face_cylindrical_metadata, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_sheetMetal_corner_fillet_selection_resolution, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_sheetMetal_corner_fillet_compound_reference, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_solidPointMinGap, printArtifacts: false, exportFaces: false, exportSolids: false, resetHistory: true },
    { test: test_solidMetrics, afterRun: afterRun_solidMetrics, printArtifacts: true, exportFaces: true, exportSolids: true, resetHistory: true },

];

registerBrowserDiscoveredSkipTests();

// Dynamically register tests to import part files from src/tests/partFiles (Node only)
async function registerPartFileTests() {
    if (!(typeof process !== 'undefined' && process.versions && process.versions.node)) return;
    try {
        const partsDir = 'src/tests/partFiles';
        // Use async API to avoid ESM sync-fs readiness issues
        try {
            const entries = await (fs.promises as any).readdir(partsDir);
            const files = entries.filter(f => typeof f === 'string' && f.toLowerCase().endsWith('.json'));
            for (const file of files) {
                const filePath = path.join(partsDir, file);
                const testName = getPartFileImportTestName(filePath);

                const importTest = async function (partHistory) {
                    // Read file and load into PartHistory
                    const content = await (fs.promises as any).readFile(filePath, 'utf8');
                    let payload = content;
                    try {
                        const obj = JSON.parse(content);
                        if (obj && typeof obj === 'object') {
                            if (Array.isArray(obj.features)) {
                                payload = JSON.stringify(obj);
                            } else if (obj.data) {
                                payload = (typeof obj.data === 'string') ? obj.data : JSON.stringify(obj.data);
                            }
                        }
                    } catch (_) {
                        // invalid JSON; let runSingleTest catch and report when fromJSON or runHistory runs
                    }
                    await partHistory.reset();
                    await partHistory.fromJSON(payload);
                    // runHistory will be called by runSingleTest()
                };
                try { Object.defineProperty(importTest, 'name', { value: testName, configurable: true }); } catch { /* ignore generated test name patch failure */ }

                testFunctions.push({
                    test: importTest,
                    afterRun: null,
                    printArtifacts: false,
                    exportFaces: true,
                    exportSolids: true,
                    resetHistory: true,
                    allowErrors: true,
                    requiresLocalFiles: true,
                    _sourceFile: filePath,
                });
            }
        } catch {
            // Directory may not exist; ignore silently in CI
        }
    } catch (e) {
        console.warn('Failed to register part file import tests:', e?.message || e);
    }
}



let discoveredTestsRegistered = false;

export async function registerDiscoveredTests() {
    if (discoveredTestsRegistered) return;
    // Discover and register part-file import tests (Node only)
    await registerPartFileTests();
    // Discover and register sketch solver topology fixtures (Node only)
    await registerSketchSolverTopologyFixtureTests(testFunctions);
    discoveredTestsRegistered = true;
}

function isCliEntryPoint() {
    if (!IS_NODE_RUNTIME) return false;
    const entry = process.argv?.[1] ? String(process.argv[1]) : "";
    if (!entry) return false;
    const normalizeEntrypoint = (value) => String(value || "")
        .replace(/^file:\/\//, "")
        .replace(/\\/g, "/")
        .replace(/^\.\//, "")
        .replace(/\.(?:js|ts)$/u, "");
    const modulePath = (() => {
        try {
            return decodeURIComponent(new URL(import.meta.url).pathname);
        } catch {
            return import.meta.url;
        }
    })();
    const moduleEntry = normalizeEntrypoint(modulePath);
    const processEntry = normalizeEntrypoint(entry);
    return moduleEntry === processEntry || moduleEntry.endsWith(`/${processEntry}`);
}

// call runTests automatically when executed directly under Node.js
if (isCliEntryPoint()) {
    runTests(new PartHistory(), null, { testName: getCliRequestedTestName(process.argv) })
        .then(() => {
            // ensure CLI exits promptly once the suite finishes
            process.exit(0);
        })
        .catch((err) => {
            console.error(err);
            process.exit(1);
        });
}




export async function runTests(partHistory = new PartHistory(), callbackToRunBetweenTests = null, options: any = {}) {
    if (typeof process !== "undefined" && process.versions && process.versions.node) {
        //await console.clear();
    }

    // delete the ./tests/results directory in an asynchronous way
    await (fs.promises as any).rm('./tests/results', { recursive: true, force: true });

    await registerDiscoveredTests();

    const testFunctionsToRun = getRequestedTestFunctions(testFunctions, options.testName);
    const testRunLog = IS_NODE_RUNTIME
        ? createTestRunLog({ filter: options.testName, plannedTests: testFunctionsToRun.map(getTestName) })
        : null;

    const failedTests = [];

    for (const testFunction of testFunctionsToRun) {
        const isLastTest = testFunction === testFunctionsToRun[testFunctionsToRun.length - 1];
        await partHistory.reset();

        if (testFunction.resetHistory) partHistory.features = [];

        const testName = getTestName(testFunction);
        const testStartMs = getMonotonicTimeMs();
        let testDurationMs = 0;
        let artifactDurationMs = 0;
        let handledError = null;
        let skipped = null;

        try {
            const testResult = await runSingleTest(testFunction, partHistory, {
                runtime: options.runtime,
                validateSolidVolumes: options.validateSolidVolumes !== false,
            });
            if (isSkippedTestResult(testResult)) {
                skipped = testResult;
            } else {
                handledError = testResult;
            }
            testDurationMs = getMonotonicTimeMs() - testStartMs;
        } catch (err) {
            testDurationMs = getMonotonicTimeMs() - testStartMs;
            failedTests.push({ name: testName, error: err });
            if (testRunLog) {
                testRunLog.recordTest({
                    name: testName,
                    status: 'failed',
                    testDurationMs,
                    artifactDurationMs,
                    error: err,
                });
            }
            console.error(`[runTests] Test failed: ${testName}`, err);
            continue;
        }

        if (skipped) {
            if (testRunLog) {
                testRunLog.recordTest({
                    name: testName,
                    status: 'skipped',
                    testDurationMs,
                    artifactDurationMs,
                    note: skipped.reason,
                });
            }
            continue;
        }

        const artifactStartMs = getMonotonicTimeMs();
        try {
            if (typeof window !== "undefined") {
                if (typeof callbackToRunBetweenTests === 'function') {
                    await callbackToRunBetweenTests(partHistory, isLastTest);
                }
            } else {
                await exportTestArtifacts({ testFunction, partHistory });
            }
        } catch (err) {
            artifactDurationMs = getMonotonicTimeMs() - artifactStartMs;
            failedTests.push({ name: testName, error: err });
            if (testRunLog) {
                testRunLog.recordTest({
                    name: testName,
                    status: 'failed',
                    testDurationMs,
                    artifactDurationMs,
                    error: err,
                });
            }
            console.error(`[runTests] Artifact export failed: ${testName}`, err);
            continue;
        }
        artifactDurationMs = getMonotonicTimeMs() - artifactStartMs;

        if (testRunLog) {
            testRunLog.recordTest({
                name: testName,
                status: handledError ? 'handled_error' : 'passed',
                testDurationMs,
                artifactDurationMs,
                error: handledError,
            });
        }
    }

    if (failedTests.length > 0) {
        if (testRunLog) testRunLog.finish('failed');
        const failures = failedTests
            .map(({ name, error }) => `${name}: ${firstLine(stringifyError(error))}`)
            .join('; ');
        throw new Error(`${failedTests.length} test(s) failed. ${failures}`);
    }

    if (testRunLog) testRunLog.finish('passed');
}










function validateSolidVolumeExpectations(testFunction, partHistory) {
    const solids = getSceneSolids(partHistory);
    if (!solids.length) return;

    const testName = getTestName(testFunction);
    const expectations = getSolidVolumeExpectations(testName);
    if (!expectations) {
        const solidNames = solids.map((solid, index) => String(solid?.name || `solid_${index}`));
        throw new Error(
            `[${testName}] Missing solid volume expectations for ${solids.length} resulting solid(s): `
                + `${solidNames.join(", ")}.`,
        );
    }

    assertSceneSolidVolumeExpectations(partHistory, expectations, testName);
}

export async function runSingleTest(testFunction, partHistory = new PartHistory(), options: any = {}) {
    const skipReason = getTestSkipReason(testFunction, options);
    if (skipReason) {
        return skippedTestResult(skipReason);
    }

    let error = null;
    try {
        await testFunction.test(partHistory);
        await partHistory.runHistory({ throwOnFeatureError: true });
        // Optional per-test post-run hook for validations/metrics
        if (typeof testFunction.afterRun === 'function') {
            try { await testFunction.afterRun(partHistory); } catch (e) { console.warn('afterRun failed:', e?.message || e); }
        }
        if (options.validateSolidVolumes !== false) {
            validateSolidVolumeExpectations(testFunction, partHistory);
        }
    } catch (e) {
        error = e;
        const runtime = options.runtime || (isBrowserRuntime() ? 'browser' : 'node');
        if (runtime === 'browser') {
            const localFileSkipReason = getBrowserLocalFileErrorSkipReason(e);
            if (localFileSkipReason) return skippedTestResult(localFileSkipReason);
        }
        if (testFunction.allowErrors) {
            const name = (testFunction.test && testFunction.test.name) ? testFunction.test.name : 'unnamed_test';
            const exportPath = `./tests/results/${name}/`;
            try { if (!fs.existsSync(exportPath)) fs.mkdirSync(exportPath, { recursive: true }); } catch { /* ignore error artifact directory failure */ }
            const msg = `${e?.message || e}\n\n${e?.stack || ''}`;
            try { writeFile(path.join(exportPath, 'error.txt'), msg); } catch { /* ignore error artifact write failure */ }
            console.error(`Error in test ${name}:`, e);
        } else {
            // rethrow to fail fast for normal tests
            throw e;
        }
    }
    const settleMs = Math.max(0, Number(testFunction.settleMs) || 0);
    if (settleMs > 0) {
        await new Promise(resolve => setTimeout(resolve, settleMs));
    }

    return error;
}


// function to write a file. If the path dose not exist it should make the folders needed.  
function writeFile(filePath, content) {
    // imediatly return if running in the browser
    if (typeof window !== "undefined") {
        //console.warn(`writeFile is not supported in the browser.`);
        return;
    }

    try {
        const dir = path.dirname(filePath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        fs.writeFileSync(filePath, content, 'utf8');
    } catch (error) {
        console.log(`Error writing file ${filePath}:`, error);
    }
}

function writeBinaryFile(filePath, content) {
    if (typeof window !== "undefined") {
        return;
    }
    try {
        const dir = path.dirname(filePath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        fs.writeFileSync(filePath, content);
    } catch (error) {
        console.log(`Error writing file ${filePath}:`, error);
    }
}

function stringifyError(err) {
    if (!err) return 'Unknown error';
    if (typeof err === 'string') return err;
    const message = err?.message || err?.toString?.() || 'Unknown error';
    if (!err?.stack) return message;
    const stack = String(err.stack);
    return stack.includes(message) ? stack : `${message}\n${stack}`;
}

function getMonotonicTimeMs() {
    if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
        return performance.now();
    }
    return Date.now();
}

function formatDurationMs(ms) {
    return (Math.max(0, Number(ms) || 0)).toFixed(3);
}

function createTestRunLog({ filter, plannedTests }: any) {
    const startedMs = getMonotonicTimeMs();
    const records: any[] = [];

    const write = (status = 'running') => {
        const elapsedMs = getMonotonicTimeMs() - startedMs;
        const passed = records.filter(record => record.status === 'passed').length;
        const handledErrors = records.filter(record => record.status === 'handled_error').length;
        const skipped = records.filter(record => record.status === 'skipped').length;
        const failed = records.filter(record => record.status === 'failed').length;
        const lines = [
            '# BREP Test Run Log',
            '',
            `log_version: ${TEST_LOG_VERSION}`,
            `status: ${status}`,
            `filter: ${filter || 'all'}`,
            `planned_tests: ${plannedTests.length}`,
            `tests_run: ${records.length}`,
            `passed: ${passed}`,
            `handled_errors: ${handledErrors}`,
            `skipped: ${skipped}`,
            `failed: ${failed}`,
            `total_elapsed_ms: ${formatDurationMs(elapsedMs)}`,
            '',
            '| # | test | status | test_ms | artifact_ms | total_ms | notes |',
            '|---:|---|---|---:|---:|---:|---|',
        ];

        records.forEach((record, index) => {
            const cells = [
                index + 1,
                escapeMarkdownTableCell(record.name),
                record.status,
                formatDurationMs(record.testDurationMs),
                formatDurationMs(record.artifactDurationMs),
                formatDurationMs(record.testDurationMs + record.artifactDurationMs),
                escapeMarkdownTableCell(record.note || ''),
            ];
            lines.push(`| ${cells.join(' | ')} |`);
        });

        if (records.length < plannedTests.length) {
            lines.push('');
            lines.push('Pending tests:');
            plannedTests.slice(records.length).forEach((name, index) => {
                lines.push(`${records.length + index + 1}. ${name}`);
            });
        }

        const recordsWithDetails = records.filter(record => record.errorDetails);
        if (recordsWithDetails.length > 0) {
            lines.push('');
            lines.push('Failure details:');
            recordsWithDetails.forEach((record, index) => {
                lines.push('');
                lines.push(`${index + 1}. ${record.name} (${record.status})`);
                lines.push('');
                lines.push('```');
                lines.push(record.errorDetails);
                lines.push('```');
            });
        }

        writeFile(TEST_LOG_PATH, `${lines.join('\n')}\n`);
    };

    write();

    return {
        records,
        recordTest({ name, status, testDurationMs, artifactDurationMs, error, note }: any) {
            records.push({
                name,
                status,
                testDurationMs,
                artifactDurationMs,
                note: note || (error ? stringifyError(error) : ''),
                errorDetails: error ? stringifyError(error) : '',
            });
            write();
        },
        finish(status) {
            write(status);
        },
    };
}

function firstLine(value) {
    return String(value || '').split(/\r?\n/)[0];
}

function escapeMarkdownTableCell(value) {
    return String(value || '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

async function exportTestArtifacts({ testFunction, partHistory }) {
    // run each test and export the results to a folder ./tests/results/<testFunction name>/
    const exportName = testFunction.test.name;
    const exportPath = `./tests/results/${exportName}/`;
    // create the directory if it does not exist
    if (!fs.existsSync(exportPath)) {
        fs.mkdirSync(exportPath, { recursive: true });
    }

    // Collect SOLID nodes from the scene
    const solids = (partHistory.scene?.children || []).filter(o => o && o.type === 'SOLID' && typeof o.toSTL === 'function');

    // Export solids (triggered by either flag for convenience)
    if (testFunction.exportSolids || testFunction.printArtifacts) {
        solids.forEach((solid, idx) => {
            const rawName = solid.name && String(solid.name).trim().length ? String(solid.name) : `solid_${idx}`;
            const safeName = sanitizeFileName(rawName);
            let stl = "";
            try {
                stl = solid.toSTL(safeName, 6);
            } catch (e) {
                console.warn(`[runTests] toSTL failed for solid ${rawName}:`, e?.message || e);
                return;
            }
            const outPath = path.join(exportPath, `${safeName}.stl`);
            writeFile(outPath, stl);
        });
    }

    // Export faces per solid
    if (testFunction.exportFaces) {
        solids.forEach((solid, sidx) => {
            const rawName = solid.name && String(solid.name).trim().length ? String(solid.name) : `solid_${sidx}`;
            const safeSolid = sanitizeFileName(rawName);
            let faces = [];
            try {
                faces = typeof solid.getFaces === 'function' ? solid.getFaces(false) : [];
            } catch {
                faces = [];
            }
            faces.forEach(({ faceName, triangles }, fIdx) => {
                if (!triangles || triangles.length === 0) return;
                const rawFace = faceName || `face_${fIdx}`;
                const safeFace = sanitizeFileName(rawFace);
                const stl = trianglesToAsciiSTL(`${safeSolid}_${safeFace}`, triangles);
                const outPath = path.join(exportPath, `${safeSolid}_${safeFace}.stl`);
                writeFile(outPath, stl);
            });
        });
    }

    // Export 3MF with embedded feature history
    await export3mfArtifact({
        partHistory,
        exportName,
        exportPath,
        solids,
    });
}

// ---------------- Local helpers for artifact export (Node only) ----------------

function sanitizeFileName(name) {
    return String(name)
        .replace(/[^a-zA-Z0-9._-]+/g, '_')      // collapse invalid chars
        .replace(/^_+|_+$/g, '')                 // trim leading/trailing underscores
        .substring(0, 100) || 'artifact';        // cap length
}

function trianglesToAsciiSTL(name, tris) {
    const fmt = (n) => Number.isFinite(n) ? (Math.abs(n) < 1e-18 ? '0' : n.toFixed(6)) : '0';
    const out = [];
    out.push(`solid ${name}`);
    for (let i = 0; i < tris.length; i++) {
        const t = tris[i];
        const p0 = t.p1, p1 = t.p2, p2 = t.p3;
        const ux = p1[0] - p0[0], uy = p1[1] - p0[1], uz = p1[2] - p0[2];
        const vx = p2[0] - p0[0], vy = p2[1] - p0[1], vz = p2[2] - p0[2];
        let nx = uy * vz - uz * vy;
        let ny = uz * vx - ux * vz;
        let nz = ux * vy - uy * vx;
        const len = Math.hypot(nx, ny, nz) || 1;
        nx /= len; ny /= len; nz /= len;
        out.push(`  facet normal ${fmt(nx)} ${fmt(ny)} ${fmt(nz)}`);
        out.push(`    outer loop`);
        out.push(`      vertex ${fmt(p0[0])} ${fmt(p0[1])} ${fmt(p0[2])}`);
        out.push(`      vertex ${fmt(p1[0])} ${fmt(p1[1])} ${fmt(p1[2])}`);
        out.push(`      vertex ${fmt(p2[0])} ${fmt(p2[1])} ${fmt(p2[2])}`);
        out.push(`    endloop`);
        out.push(`  endfacet`);
    }
    out.push(`endsolid ${name}`);
    return out.join('\n');
}

async function export3mfArtifact({ partHistory, exportName, exportPath, solids }) {
    let historyJson = null;
    try {
        const json = await partHistory?.toJSON?.();
        if (json) historyJson = (typeof json === 'string') ? json : JSON.stringify(json);
    } catch (e) {
        console.warn(`[runTests] Failed to serialize feature history for ${exportName}:`, e?.message || e);
    }

    let additionalFiles: any = historyJson ? { 'Metadata/featureHistory.json': historyJson } : undefined;
    let modelMetadata: any = historyJson ? { featureHistoryPath: '/Metadata/featureHistory.json' } : undefined;
    const metadataManager = partHistory?.metadataManager || null;
    try {
        const flatPatterns = buildSheetMetalFlatPatternPackageFiles(solids || [], {
            baseName: exportName || 'partHistory',
        });
        if (flatPatterns.files.length) {
            additionalFiles = { ...(additionalFiles || {}), ...flatPatterns.additionalFiles };
            modelMetadata = {
                ...(modelMetadata || {}),
                sheetMetalFlatPatternPaths: flatPatterns.paths.map((p) => `/${p}`).join(';'),
            };
        }
        if (flatPatterns.skipped.length) {
            console.warn(`[runTests] Skipped ${flatPatterns.skipped.length} sheet metal flat pattern(s) for ${exportName}`);
        }
    } catch (e) {
        console.warn(`[runTests] Failed to package sheet metal flat patterns for ${exportName}:`, e?.message || e);
    }

    const solidsForExport = [];
    (solids || []).forEach((s, idx) => {
        try {
            const mesh = s?.getMesh?.();
            const canExport = !!(mesh && mesh.vertProperties && mesh.triVerts);
            if (mesh && typeof mesh.delete === 'function') {
                try { mesh.delete(); } catch { /* ignore mesh cleanup failure */ }
            }
            if (canExport) {
                solidsForExport.push(s);
            } else {
                const name = sanitizeFileName(s?.name || `solid_${idx}`);
                console.warn(`[runTests] Skipping non-manifold solid for 3MF: ${name}`);
            }
        } catch {
            const name = sanitizeFileName(s?.name || `solid_${idx}`);
            console.warn(`[runTests] Skipping solid that failed to export for 3MF: ${name}`);
        }
    });

    const safeName = sanitizeFileName(exportName || 'partHistory');
    const outPath = path.join(exportPath, `${safeName}.3mf`);
    try {
        let data = null;
        try {
            data = await generate3MF(solidsForExport, {
                unit: 'millimeter',
                precision: 6,
                scale: 1,
                additionalFiles,
                modelMetadata,
                metadataManager,
            });
        } catch {
            data = await generate3MF([], {
                unit: 'millimeter',
                precision: 6,
                scale: 1,
                additionalFiles,
                modelMetadata,
                metadataManager,
            });
        }
        if (data && data.length) {
            writeBinaryFile(outPath, data);
        } else {
            console.warn(`[runTests] 3MF export returned empty payload for ${exportName}`);
        }
    } catch (e) {
        console.warn(`[runTests] 3MF export failed for ${exportName}:`, e?.message || e);
    }
}
