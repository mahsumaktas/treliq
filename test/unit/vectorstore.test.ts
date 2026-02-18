const mockConnect = jest.fn();

jest.mock('@lancedb/lancedb', () => ({
  connect: (...args: any[]) => mockConnect(...args),
}));

import { VectorStore, type VectorRecord } from '../../src/core/vectorstore';

function makeSearchChain(rows: any[]) {
  return {
    limit: jest.fn().mockReturnValue({
      toArray: jest.fn().mockResolvedValue(rows),
    }),
  };
}

describe('VectorStore', () => {
  let db: any;

  beforeEach(() => {
    db = {
      tableNames: jest.fn().mockResolvedValue([]),
      dropTable: jest.fn().mockResolvedValue(undefined),
      createTable: jest.fn().mockResolvedValue(undefined),
      openTable: jest.fn().mockResolvedValue({
        vectorSearch: jest.fn().mockReturnValue(makeSearchChain([])),
      }),
    };
    mockConnect.mockReset();
    mockConnect.mockResolvedValue(db);
  });

  it('connects to LanceDB', async () => {
    const store = new VectorStore();
    await store.connect('/tmp/lance');
    expect(mockConnect).toHaveBeenCalledWith('/tmp/lance');
  });

  it('throws when upsertEmbeddings is called before connect', async () => {
    const store = new VectorStore();
    await expect(store.upsertEmbeddings([{ prNumber: 1, embedding: [0.1, 0.2] }]))
      .rejects.toThrow('VectorStore not connected');
  });

  it('returns early when upserting empty records', async () => {
    const store = new VectorStore();
    await store.connect('/tmp/lance');
    await store.upsertEmbeddings([]);
    expect(db.createTable).not.toHaveBeenCalled();
  });

  it('drops existing table before creating a new one', async () => {
    db.tableNames.mockResolvedValue(['pr_embeddings']);
    const store = new VectorStore();
    await store.connect('/tmp/lance');

    const records: VectorRecord[] = [{ prNumber: 7, embedding: [0.3, 0.7] }];
    await store.upsertEmbeddings(records);

    expect(db.dropTable).toHaveBeenCalledWith('pr_embeddings');
    expect(db.createTable).toHaveBeenCalledWith('pr_embeddings', [
      { pr_number: 7, vector: [0.3, 0.7] },
    ]);
  });

  it('throws when findSimilar is called before connect', async () => {
    const store = new VectorStore();
    await expect(store.findSimilar([1, 0], 0.8)).rejects.toThrow('VectorStore not connected');
  });

  it('returns empty array when embeddings table does not exist', async () => {
    db.tableNames.mockResolvedValue([]);
    const store = new VectorStore();
    await store.connect('/tmp/lance');

    const results = await store.findSimilar([1, 0], 0.8);
    expect(results).toEqual([]);
  });

  it('filters similar rows by threshold', async () => {
    db.tableNames.mockResolvedValue(['pr_embeddings']);
    const vectorSearch = jest.fn().mockReturnValue(makeSearchChain([
      { pr_number: 1, _distance: 0.1 }, // sim 0.95
      { pr_number: 2, _distance: 0.8 }, // sim 0.60
    ]));
    db.openTable.mockResolvedValue({ vectorSearch });

    const store = new VectorStore();
    await store.connect('/tmp/lance');

    const results = await store.findSimilar([1, 0], 0.8);
    expect(results).toEqual([
      { prNumber: 1, distance: 0.1, similarity: 0.95 },
    ]);
  });

  it('throws when findAllPairsAboveThreshold is called before connect', async () => {
    const store = new VectorStore();
    await expect(store.findAllPairsAboveThreshold([{ prNumber: 1, embedding: [1, 0] }], 0.8))
      .rejects.toThrow('VectorStore not connected');
  });

  it('returns empty pairs when fewer than 2 records are provided', async () => {
    const store = new VectorStore();
    await store.connect('/tmp/lance');

    const pairs = await store.findAllPairsAboveThreshold([{ prNumber: 1, embedding: [1, 0] }], 0.8);
    expect(pairs).toEqual([]);
  });

  it('returns unique pairs above threshold', async () => {
    const rowsByPR: Record<number, any[]> = {
      1: [{ pr_number: 2, _distance: 0.1 }], // sim 0.95
      2: [{ pr_number: 1, _distance: 0.2 }], // sim 0.90 (duplicate pair)
      3: [{ pr_number: 1, _distance: 1.0 }], // sim 0.50
    };
    const vectorSearch = jest.fn().mockImplementation((embedding: number[]) => {
      const id = embedding[0];
      return makeSearchChain(rowsByPR[id] ?? []);
    });

    db.openTable.mockResolvedValue({ vectorSearch });
    const store = new VectorStore();
    await store.connect('/tmp/lance');

    const records: VectorRecord[] = [
      { prNumber: 1, embedding: [1] },
      { prNumber: 2, embedding: [2] },
      { prNumber: 3, embedding: [3] },
    ];
    const pairs = await store.findAllPairsAboveThreshold(records, 0.8);

    expect(pairs).toEqual([
      { a: 1, b: 2, sim: 0.95 },
    ]);
    expect(db.createTable).toHaveBeenCalled();
  });
});
