// api/start_sequence.js  (ES module style)
export default async function handler(req, res) {
  try {
    if (req.method !== 'POST') {
      return res.status(405).json({ error: 'Method not allowed' });
    }

    // Basic request logging (safe, don't log secrets in prod)
    const invocationId = req.headers['x-vercel-id'] || 'unknown';
    console.info('[start_sequence] invocation', invocationId, 'headers present');

    const payload = req.body ?? {};
    const { owner_id, job_ids, sequence_id } = payload;

    if (!owner_id) {
      return res.status(400).json({ error: 'owner_id required' });
    }

    // Normalize job_ids:
    let jobs = [];
    if (Array.isArray(job_ids)) {
      jobs = job_ids.filter(Boolean);
    } else if (typeof job_ids === 'string') {
      const trimmed = job_ids.trim();
      if (trimmed.length > 0) {
        jobs = trimmed.includes(',') ? trimmed.split(',').map(s => s.trim()).filter(Boolean) : [trimmed];
      }
    } else if (typeof job_ids === 'number' || typeof job_ids === 'bigint') {
      jobs = [String(job_ids)];
    }

    if (jobs.length === 0) {
      console.warn('[start_sequence] no job_ids provided after normalization', { owner_id, sequence_id });
      return res.status(202).json({
        message: 'No job_ids provided; nothing to start',
        owner_id,
        sequence_id
      });
    }

    // Business logic placeholder — do your processing here
    // await processJobs(owner_id, jobs, sequence_id);

    return res.status(200).json({ message: 'started', count: jobs.length });
  } catch (err) {
    console.error('[start_sequence] unexpected error', err);
    const invocationId = req.headers['x-vercel-id'] || 'unknown';
    return res.status(500).json({
      error: 'FUNCTION_INVOCATION_FAILED',
      message: 'An internal error occurred',
      invocationId
    });
  }
}
