-- @query requests
-- Candidate changes are independent. earliest_cache_break is only the FIRST known break in cache order.
WITH probe AS (
 SELECT p.*, u.timestamp AS ts, u.provider, u.model,
 COALESCE(u.prompt_tokens,0)+COALESCE(u.cache_read,0)+COALESCE(u.cache_write,0) AS input_tokens,
 COALESCE(u.cache_read,0) AS cache_read, COALESCE(u.cache_write,0) AS cache_write
 FROM request_probe p JOIN token_usage u ON u.id=p.usage_id
 WHERE p.created_at >= datetime('now','-30 days')
), seq AS (
 SELECT probe.*,
 LAG(id) OVER w AS prev_id, LAG(ts) OVER w AS prev_ts,
 LAG(input_tokens) OVER w AS prev_input, LAG(history_chars) OVER w AS prev_history_chars,
 LAG(provider) OVER w AS prev_provider, LAG(model) OVER w AS prev_model,
 LAG(tools_hash) OVER w AS prev_tools_hash, LAG(tools_chars) OVER w AS prev_tools_chars,
 LAG(sys_pre_hash) OVER w AS prev_sys_pre_hash, LAG(sys_pre_chars) OVER w AS prev_sys_pre_chars,
 LAG(sys_post_hash) OVER w AS prev_sys_post_hash, LAG(sys_post_chars) OVER w AS prev_sys_post_chars
 FROM probe WINDOW w AS (PARTITION BY session_id ORDER BY id)
), flags AS (
 SELECT seq.*,
 CASE WHEN prev_id IS NOT NULL AND (julianday(ts)-julianday(prev_ts))*1440 <= 60 THEN 1 ELSE 0 END AS in_ttl,
 CASE WHEN prev_input>0 AND cache_read < 0.8*prev_input THEN 1 ELSE 0 END AS rewrite,
 CASE WHEN prev_id IS NOT NULL AND (tools_hash IS NOT prev_tools_hash OR tools_chars<>prev_tools_chars) THEN 1 ELSE 0 END AS tools_changed,
 CASE WHEN prev_id IS NOT NULL AND (sys_pre_hash IS NOT prev_sys_pre_hash OR sys_pre_chars<>prev_sys_pre_chars) THEN 1 ELSE 0 END AS sys_pre_changed,
 CASE WHEN prev_id IS NOT NULL AND (sys_post_hash IS NOT prev_sys_post_hash OR sys_post_chars<>prev_sys_post_chars) THEN 1 ELSE 0 END AS sys_post_changed,
 CASE WHEN prev_id IS NOT NULL AND (provider IS NOT prev_provider OR model IS NOT prev_model) THEN 1 ELSE 0 END AS target_changed,
 CASE WHEN COALESCE(trim_dropped,0)>0 THEN 1 ELSE 0 END AS trim_removed,
 CASE WHEN COALESCE(trim_repaired,0)=1 THEN 1 ELSE 0 END AS window_repaired
 FROM seq
), classified AS (
 SELECT flags.*,
 CASE WHEN prev_id IS NULL THEN 'first'
 WHEN tools_changed=1 THEN 'tools' WHEN sys_pre_changed=1 THEN 'sys_pre'
 WHEN sys_post_changed=1 THEN 'sys_post' WHEN target_changed=1 THEN 'target'
 WHEN history_kept_msgs IS NULL THEN 'no_history'
 WHEN first_difference='shifted' AND trim_removed=1 THEN 'trim'
 WHEN first_difference='context_removed' THEN 'context_removed'
 WHEN first_difference='shifted' THEN 'shifted'
 WHEN first_difference='changed' THEN 'history' ELSE 'none' END AS earliest_cache_break,
 CASE WHEN prev_msg_count>0 THEN ROUND(1.0*COALESCE(shifted_kept_chars,context_kept_chars,history_kept_chars,0)/NULLIF(prev_history_chars,0),3) END AS estimated_history_kept_share
 FROM flags
)
SELECT *, CASE WHEN trim_removed=1 OR window_repaired=1 THEN 1 ELSE 0 END AS trim_active
FROM classified ORDER BY session_id,id;

-- @query causes
-- Cross table: independent flags, including overlapping trim and prompt/tool changes.
WITH probe AS (
 SELECT p.*, u.timestamp AS ts, u.provider, u.model,
 COALESCE(u.prompt_tokens,0)+COALESCE(u.cache_read,0)+COALESCE(u.cache_write,0) AS input_tokens,
 COALESCE(u.cache_read,0) AS cache_read, COALESCE(u.cache_write,0) AS cache_write
 FROM request_probe p JOIN token_usage u ON u.id=p.usage_id
 WHERE p.created_at >= datetime('now','-30 days')
), seq AS (
 SELECT probe.*,
 LAG(id) OVER w AS prev_id, LAG(ts) OVER w AS prev_ts,
 LAG(input_tokens) OVER w AS prev_input, LAG(history_chars) OVER w AS prev_history_chars,
 LAG(provider) OVER w AS prev_provider, LAG(model) OVER w AS prev_model,
 LAG(tools_hash) OVER w AS prev_tools_hash, LAG(tools_chars) OVER w AS prev_tools_chars,
 LAG(sys_pre_hash) OVER w AS prev_sys_pre_hash, LAG(sys_pre_chars) OVER w AS prev_sys_pre_chars,
 LAG(sys_post_hash) OVER w AS prev_sys_post_hash, LAG(sys_post_chars) OVER w AS prev_sys_post_chars
 FROM probe WINDOW w AS (PARTITION BY session_id ORDER BY id)
), flags AS (
 SELECT seq.*,
 CASE WHEN prev_id IS NOT NULL AND (julianday(ts)-julianday(prev_ts))*1440 <= 60 THEN 1 ELSE 0 END AS in_ttl,
 CASE WHEN prev_input>0 AND cache_read < 0.8*prev_input THEN 1 ELSE 0 END AS rewrite,
 CASE WHEN prev_id IS NOT NULL AND (tools_hash IS NOT prev_tools_hash OR tools_chars<>prev_tools_chars) THEN 1 ELSE 0 END AS tools_changed,
 CASE WHEN prev_id IS NOT NULL AND (sys_pre_hash IS NOT prev_sys_pre_hash OR sys_pre_chars<>prev_sys_pre_chars) THEN 1 ELSE 0 END AS sys_pre_changed,
 CASE WHEN prev_id IS NOT NULL AND (sys_post_hash IS NOT prev_sys_post_hash OR sys_post_chars<>prev_sys_post_chars) THEN 1 ELSE 0 END AS sys_post_changed,
 CASE WHEN prev_id IS NOT NULL AND (provider IS NOT prev_provider OR model IS NOT prev_model) THEN 1 ELSE 0 END AS target_changed,
 CASE WHEN COALESCE(trim_dropped,0)>0 THEN 1 ELSE 0 END AS trim_removed,
 CASE WHEN COALESCE(trim_repaired,0)=1 THEN 1 ELSE 0 END AS window_repaired
 FROM seq
), classified AS (
 SELECT flags.*,
 CASE WHEN prev_id IS NULL THEN 'first'
 WHEN tools_changed=1 THEN 'tools' WHEN sys_pre_changed=1 THEN 'sys_pre'
 WHEN sys_post_changed=1 THEN 'sys_post' WHEN target_changed=1 THEN 'target'
 WHEN history_kept_msgs IS NULL THEN 'no_history'
 WHEN first_difference='shifted' AND trim_removed=1 THEN 'trim'
 WHEN first_difference='context_removed' THEN 'context_removed'
 WHEN first_difference='shifted' THEN 'shifted'
 WHEN first_difference='changed' THEN 'history' ELSE 'none' END AS earliest_cache_break,
 CASE WHEN prev_msg_count>0 THEN ROUND(1.0*COALESCE(shifted_kept_chars,context_kept_chars,history_kept_chars,0)/NULLIF(prev_history_chars,0),3) END AS estimated_history_kept_share
 FROM flags
)
SELECT turn_kind, tools_changed, sys_pre_changed, sys_post_changed, target_changed,
 trim_removed, window_repaired, first_difference, earliest_cache_break,
 COUNT(*) AS turn_starts, SUM(rewrite) AS rewrites,
 ROUND(100.0*SUM(rewrite)/COUNT(*),1) AS rewrite_pct,
 SUM(CASE WHEN rewrite=1 THEN cache_write ELSE 0 END) AS rewrite_write_tokens,
 ROUND(100.0*SUM(CASE WHEN rewrite=1 THEN cache_write ELSE 0 END)/NULLIF((SELECT SUM(CASE WHEN rewrite=1 THEN cache_write ELSE 0 END) FROM classified WHERE turn_seq=0 AND in_ttl=1),0),1) AS share_of_rewrite_writes_pct,
 ROUND(AVG(input_tokens)) AS avg_input,
 ROUND(AVG(est_sys_tokens)) AS avg_est_sys,
 ROUND(AVG(est_tools_tokens)) AS avg_est_tools,
 ROUND(AVG(est_history_tokens)) AS avg_est_history,
 ROUND(AVG(est_new_tokens)) AS avg_est_new,
 ROUND(AVG(estimated_history_kept_share),3) AS avg_history_kept_share
FROM classified WHERE turn_seq=0 AND in_ttl=1
GROUP BY turn_kind,tools_changed,sys_pre_changed,sys_post_changed,target_changed,trim_removed,window_repaired,first_difference,earliest_cache_break
ORDER BY rewrite_write_tokens DESC;

-- @query decision
-- Writes with an actual trim versus context removal alone; overlap is counted only in trim.
-- avg_history_kept_share can exceed 1 (for example, 1.134):
-- prev_history_chars excludes the new message, while the retained-context numerator
-- can include it. This character-based estimate is not a percentage capped at 100%.
WITH probe AS (
 SELECT p.*, u.timestamp AS ts, u.provider, u.model,
 COALESCE(u.prompt_tokens,0)+COALESCE(u.cache_read,0)+COALESCE(u.cache_write,0) AS input_tokens,
 COALESCE(u.cache_read,0) AS cache_read, COALESCE(u.cache_write,0) AS cache_write
 FROM request_probe p JOIN token_usage u ON u.id=p.usage_id
 WHERE p.created_at >= datetime('now','-30 days')
), seq AS (
 SELECT probe.*,
 LAG(id) OVER w AS prev_id, LAG(ts) OVER w AS prev_ts,
 LAG(input_tokens) OVER w AS prev_input, LAG(history_chars) OVER w AS prev_history_chars,
 LAG(provider) OVER w AS prev_provider, LAG(model) OVER w AS prev_model,
 LAG(tools_hash) OVER w AS prev_tools_hash, LAG(tools_chars) OVER w AS prev_tools_chars,
 LAG(sys_pre_hash) OVER w AS prev_sys_pre_hash, LAG(sys_pre_chars) OVER w AS prev_sys_pre_chars,
 LAG(sys_post_hash) OVER w AS prev_sys_post_hash, LAG(sys_post_chars) OVER w AS prev_sys_post_chars
 FROM probe WINDOW w AS (PARTITION BY session_id ORDER BY id)
), flags AS (
 SELECT seq.*,
 CASE WHEN prev_id IS NOT NULL AND (julianday(ts)-julianday(prev_ts))*1440 <= 60 THEN 1 ELSE 0 END AS in_ttl,
 CASE WHEN prev_input>0 AND cache_read < 0.8*prev_input THEN 1 ELSE 0 END AS rewrite,
 CASE WHEN prev_id IS NOT NULL AND (tools_hash IS NOT prev_tools_hash OR tools_chars<>prev_tools_chars) THEN 1 ELSE 0 END AS tools_changed,
 CASE WHEN prev_id IS NOT NULL AND (sys_pre_hash IS NOT prev_sys_pre_hash OR sys_pre_chars<>prev_sys_pre_chars) THEN 1 ELSE 0 END AS sys_pre_changed,
 CASE WHEN prev_id IS NOT NULL AND (sys_post_hash IS NOT prev_sys_post_hash OR sys_post_chars<>prev_sys_post_chars) THEN 1 ELSE 0 END AS sys_post_changed,
 CASE WHEN prev_id IS NOT NULL AND (provider IS NOT prev_provider OR model IS NOT prev_model) THEN 1 ELSE 0 END AS target_changed,
 CASE WHEN COALESCE(trim_dropped,0)>0 THEN 1 ELSE 0 END AS trim_removed,
 CASE WHEN COALESCE(trim_repaired,0)=1 THEN 1 ELSE 0 END AS window_repaired
 FROM seq
), classified AS (
 SELECT flags.*,
 CASE WHEN prev_id IS NULL THEN 'first'
 WHEN tools_changed=1 THEN 'tools' WHEN sys_pre_changed=1 THEN 'sys_pre'
 WHEN sys_post_changed=1 THEN 'sys_post' WHEN target_changed=1 THEN 'target'
 WHEN history_kept_msgs IS NULL THEN 'no_history'
 WHEN first_difference='shifted' AND trim_removed=1 THEN 'trim'
 WHEN first_difference='context_removed' THEN 'context_removed'
 WHEN first_difference='shifted' THEN 'shifted'
 WHEN first_difference='changed' THEN 'history' ELSE 'none' END AS earliest_cache_break,
 CASE WHEN prev_msg_count>0 THEN ROUND(1.0*COALESCE(shifted_kept_chars,context_kept_chars,history_kept_chars,0)/NULLIF(prev_history_chars,0),3) END AS estimated_history_kept_share
 FROM flags
)
SELECT CASE WHEN trim_removed=1 THEN 'trim_removed'
 WHEN first_difference='context_removed' AND window_repaired=0 AND tools_changed=0 AND sys_pre_changed=0 AND sys_post_changed=0 AND target_changed=0 THEN 'context_only'
 ELSE 'other' END AS scenario,
 COUNT(*) AS turn_starts, SUM(rewrite) AS rewrites,
 SUM(CASE WHEN rewrite=1 THEN cache_write ELSE 0 END) AS rewrite_write_tokens,
 ROUND(AVG(CASE WHEN rewrite=1 THEN estimated_history_kept_share END),3) AS avg_history_kept_share
FROM classified WHERE turn_seq=0 AND in_ttl=1 AND turn_kind='interactive'
GROUP BY scenario ORDER BY scenario;

-- @query health
-- Denominator comes from usage; aborted streams without usage are invisible here.
SELECT date(u.timestamp) AS day,u.provider,u.model,
 COUNT(*) AS strand_requests, COUNT(p.id) AS probe_rows,
 ROUND(100.0*COUNT(p.id)/COUNT(*),1) AS coverage_pct
FROM token_usage u
LEFT JOIN request_probe p ON p.usage_id=u.id
WHERE u.timestamp>=datetime('now','-30 days') AND u.kind='request'
 AND u.session_id IS NOT NULL AND u.session_id NOT IN
 (SELECT session_id FROM tasks WHERE session_id IS NOT NULL)
GROUP BY day,u.provider,u.model ORDER BY day,u.provider,u.model;

-- @query legacy_population
-- Comparable population and turn definition: all Anthropic strand usage, turn_id changes.
WITH series AS (
 SELECT u.*, LAG(timestamp) OVER w AS prev_ts,
 LAG(turn_id) OVER w AS prev_turn, LAG(COALESCE(prompt_tokens,0)+COALESCE(cache_read,0)+COALESCE(cache_write,0)) OVER w AS prev_input
 FROM token_usage u WHERE kind='request' AND provider='anthropic'
 AND timestamp>=datetime('now','-30 days') AND session_id IS NOT NULL
 AND session_id NOT IN (SELECT session_id FROM tasks WHERE session_id IS NOT NULL)
 WINDOW w AS (PARTITION BY session_id ORDER BY timestamp,id)
)
SELECT COUNT(*) AS turn_starts,
 SUM(CASE WHEN prev_input>0 AND cache_read<0.8*prev_input THEN 1 ELSE 0 END) AS rewrites,
 SUM(CASE WHEN prev_input>0 AND cache_read<0.8*prev_input THEN cache_write ELSE 0 END) AS rewrite_write_tokens,
 COUNT(p.id) AS measured_turn_starts
FROM series s LEFT JOIN request_probe p ON p.usage_id=s.id
WHERE prev_ts IS NOT NULL AND (julianday(timestamp)-julianday(prev_ts))*1440<=60
 AND turn_id IS NOT prev_turn;
