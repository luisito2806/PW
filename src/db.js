// Atajos sobre D1 con la misma forma que usaba el backend anterior.
// D1 no acepta `undefined` como parámetro, así que se convierte en NULL.
function consulta(db, sql, params = []) {
    return db.prepare(sql).bind(...params.map(p => (p === undefined ? null : p)));
}

export const dbGet = (db, sql, params) => consulta(db, sql, params).first();

export async function dbAll(db, sql, params) {
    const { results } = await consulta(db, sql, params).all();
    return results || [];
}

// Devuelve { lastID, changes } como el sqlite3 de Node
export async function dbRun(db, sql, params) {
    const { meta } = await consulta(db, sql, params).run();
    return { lastID: meta.last_row_id, changes: meta.changes };
}
