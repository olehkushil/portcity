import {
  CONTENT_IMPORT_JOBS,
  contentImportJobId,
  handleContentImportQueueJob,
  parseContentImportJobData,
} from './content-import-queue.job';

const DATA = {
  runId: 'run-1',
  actor: { id: 'admin-1', ip: '10.0.0.1' },
  source: 'wordpress',
  dryRun: true,
  posts: [{ id: 15, title: { rendered: 'Aroma Kava' } }],
  defaults: { participates: false },
};

describe('content-import queue job', () => {
  it('builds BullMQ-safe job ids', () => {
    expect(contentImportJobId('0192f3a0-0000-7000-8000-000000000001')).toBe(
      'content-import-0192f3a0-0000-7000-8000-000000000001',
    );
  });

  it('parses the job data that crossed Redis as JSON', () => {
    expect(parseContentImportJobData(DATA)).toEqual(DATA);
    expect(parseContentImportJobData({ ...DATA, actor: { id: 'admin-1' } })?.actor).toEqual({
      id: 'admin-1',
      ip: null,
    });
    expect(parseContentImportJobData({ ...DATA, source: 'ftp' })).toBeNull();
    expect(parseContentImportJobData({ ...DATA, runId: '' })).toBeNull();
    expect(parseContentImportJobData({ ...DATA, actor: null })).toBeNull();
    expect(parseContentImportJobData('run-1')).toBeNull();
  });

  it('executes a run job and reports the final status', async () => {
    const execute = jest.fn().mockResolvedValue('succeeded');
    const result = await handleContentImportQueueJob(CONTENT_IMPORT_JOBS.run, DATA, { execute });
    expect(result).toEqual({ runId: 'run-1', status: 'succeeded' });
    expect(execute).toHaveBeenCalledWith(DATA);
  });

  it('propagates infrastructure errors so BullMQ retries', async () => {
    const execute = jest.fn().mockRejectedValue(new Error('db down'));
    await expect(
      handleContentImportQueueJob(CONTENT_IMPORT_JOBS.run, DATA, { execute }),
    ).rejects.toThrow('db down');
  });

  it('ignores unknown job names and malformed data', async () => {
    const execute = jest.fn();
    expect(await handleContentImportQueueJob('other', DATA, { execute })).toEqual({
      runId: null,
      status: 'ignored',
    });
    expect(await handleContentImportQueueJob(CONTENT_IMPORT_JOBS.run, {}, { execute })).toEqual({
      runId: null,
      status: 'ignored',
    });
    expect(execute).not.toHaveBeenCalled();
  });
});
