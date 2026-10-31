// In-memory long-job progress (index scan, bulk screener, multi-bagger research).
const jobs = new Map(); // jobId -> { completed, total, startedAt, message, phase, detail }
const JOB_TTL_MS = 15 * 60 * 1000;

function startJob(jobId, total, message = '') {
  if (!jobId) return;
  jobs.set(jobId, {
    completed: 0,
    total: total || 0,
    startedAt: Date.now(),
    message: message || 'Starting…',
    phase: 'start',
    detail: null,
    logs: [],
  });
}

function updateJob(jobId, completed, extra = {}) {
  if (!jobId) return;
  const job = jobs.get(jobId);
  if (!job) return;
  if (completed != null) job.completed = completed;
  if (extra.total != null) job.total = extra.total;
  if (extra.message != null) job.message = extra.message;
  if (extra.phase != null) job.phase = extra.phase;
  if (extra.detail != null) job.detail = extra.detail;
  if (extra.recent != null) job.recent = extra.recent;
  if (extra.scanCompleted != null) job.scanCompleted = extra.scanCompleted;
  if (extra.scanTotal != null) job.scanTotal = extra.scanTotal;
  if (extra.log) {
    job.logs = (job.logs || []).slice(-40);
    job.logs.push({ t: Date.now(), text: extra.log });
  }
}

function getJob(jobId) {
  const job = jobs.get(jobId);
  if (!job) return null;
  if (Date.now() - job.startedAt > JOB_TTL_MS) {
    jobs.delete(jobId);
    return null;
  }
  const pct = job.total > 0 ? Math.min(100, Math.round((job.completed / job.total) * 100)) : 0;
  return {
    jobId,
    completed: job.completed,
    total: job.total,
    percent: pct,
    message: job.message,
    phase: job.phase,
    detail: job.detail,
    recent: job.recent || [],
    scanCompleted: job.scanCompleted,
    scanTotal: job.scanTotal,
    logs: job.logs || [],
    startedAt: job.startedAt,
    result: job.result != null ? job.result : undefined,
    done: job.phase === 'done',
  };
}

function endJob(jobId, message = 'Done', result = null) {
  if (!jobId) return;
  const job = jobs.get(jobId);
  if (job) {
    job.completed = job.total || job.completed;
    job.message = message;
    job.phase = 'done';
    if (result != null) job.result = result;
  }
  setTimeout(() => jobs.delete(jobId), 60000);
}

module.exports = { startJob, updateJob, getJob, endJob };
