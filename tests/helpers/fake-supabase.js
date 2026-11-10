// In-memory stand-in for the supabase-js query builder used by js/auth.js
// (Batch D2/D3 tests). Supports select / insert / update / delete / upsert
// with eq / in / range / limit / maybeSingle and a returning .select().
//
// tables: { tableName: [rows] } — the stored rows (mutated by writes).
// opts:
//   fail: 'table'      → selects on that table return an error
//   hang: 'table'      → selects on that table never resolve
//   upsertError / writeError: every write returns { error }
//   pk: true           → inserts enforce the primary key (23505 on duplicate)
//   rev: true          → inserts set rev = 1; updates that change a row bump it
//
// client.upserts records every write attempt (also failed ones) as
// { table, op, rows }. For update/delete, rows = [{ ...eq filters, ...payload }],
// so tests can read the row key from it like from an upserted row.
const PK = {
    reviews: ['review_type', 'review_key'],
    daily_planners: ['planner_key'],
    weekly_planners: ['planner_key'],
    user_meta: ['key'],
    user_settings: [],
    user_integration_keys: ['provider'],
};
const clone = v => JSON.parse(JSON.stringify(v));

function fakeSupabase(tables, opts) {
    opts = opts || {};
    tables = tables || {};
    const writes = [];
    const writeError = opts.upsertError || opts.writeError;

    function rowsOf(table) { return tables[table] || (tables[table] = []); }
    function pkOf(table) { return ['user_id'].concat(PK[table] || ['id']); }
    // Fixture rows may leave out user_id; they then belong to every user.
    function matches(row, filters) {
        return filters.every(f => {
            if (f.c === 'user_id' && !('user_id' in row)) return true;
            return f.op === 'in' ? f.v.map(String).includes(String(row[f.c])) : String(row[f.c]) === String(f.v);
        });
    }

    function builder(table) {
        const st = { op: null, filters: [], payload: null, returning: false, single: false, limit: null, range: null };
        const b = {
            select(cols, o) { if (st.op) st.returning = true; else { st.op = 'select'; st.head = !!(o && o.head); st.count = !!(o && o.count); } return b; },
            insert(rows) { st.op = 'insert'; st.payload = Array.isArray(rows) ? rows : [rows]; return b; },
            update(payload, o) { st.op = 'update'; st.payload = payload; st.count = !!(o && o.count); return b; },
            delete() { st.op = 'delete'; return b; },
            upsert(rows) { st.op = 'upsert'; st.payload = Array.isArray(rows) ? rows : [rows]; return b; },
            eq(c, v) { st.filters.push({ c, v }); return b; },
            in(c, v) { st.filters.push({ c, v, op: 'in' }); return b; },
            limit(n) { st.limit = n; return b; },
            maybeSingle() { st.single = true; return b; },
            range(a, z) { st.range = [a, z]; return run(); },
            then(res, rej) { return run().then(res, rej); },
        };

        function filterObj() {
            const o = {};
            st.filters.forEach(f => { if (!f.op) o[f.c] = f.v; });
            return o;
        }

        function run() {
            if (st.op === 'select') {
                if (opts.hang === table) return new Promise(() => {});
                if (opts.fail === table) return Promise.resolve({ data: null, error: { message: table + ' down' } });
                let data = rowsOf(table).filter(r => matches(r, st.filters));
                if (st.head) return Promise.resolve({ data: null, count: data.length, error: null });
                if (st.range) data = data.slice(st.range[0], st.range[1] + 1);
                if (st.limit != null) data = data.slice(0, st.limit);
                data = clone(data);
                if (st.single) return Promise.resolve({ data: data[0] || null, error: null });
                return Promise.resolve({ data, error: null });
            }
            const rec = { table, op: st.op };
            if (st.op === 'insert' || st.op === 'upsert') rec.rows = clone(st.payload);
            else rec.rows = [Object.assign(filterObj(), clone(st.payload || {}))];
            writes.push(rec);
            if (writeError) return Promise.resolve({ data: null, error: { message: 'write failed' } });

            const stored = rowsOf(table);
            const pk = pkOf(table);
            const samePk = (a, z) => pk.every(c => String(a[c]) === String(z[c]));
            if (st.op === 'insert') {
                if (opts.pk && st.payload.some(r => stored.some(s => samePk(s, r)))) {
                    return Promise.resolve({ data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint' } });
                }
                const added = st.payload.map(r => Object.assign(clone(r), opts.rev ? { rev: 1 } : {}));
                added.forEach(r => stored.push(r));
                return Promise.resolve({ data: st.returning ? clone(added) : null, error: null });
            }
            if (st.op === 'upsert') {
                st.payload.forEach(r => {
                    const i = stored.findIndex(s => samePk(s, r));
                    if (i >= 0) stored[i] = Object.assign(stored[i], clone(r));
                    else stored.push(Object.assign(clone(r), opts.rev ? { rev: 1 } : {}));
                });
                return Promise.resolve({ data: null, error: null });
            }
            const hit = stored.filter(r => matches(r, st.filters));
            if (st.op === 'update') {
                hit.forEach(r => {
                    const before = JSON.stringify(r);
                    Object.assign(r, clone(st.payload));
                    if (opts.rev && JSON.stringify(r) !== before) r.rev = (r.rev || 1) + 1;
                });
                return Promise.resolve({ data: st.returning ? clone(hit) : null, count: st.count ? hit.length : null, error: null });
            }
            if (st.op === 'delete') {
                tables[table] = stored.filter(r => !hit.includes(r));
                return Promise.resolve({ data: st.returning ? clone(hit) : null, error: null });
            }
            return Promise.resolve({ data: null, error: { message: 'unsupported op' } });
        }
        return b;
    }

    return { tables, upserts: writes, writes, from: builder };
}

module.exports = { fakeSupabase };
