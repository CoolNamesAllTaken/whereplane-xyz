// The path regex in nginx.conf.template already limits z to 0..19 and x/y to digits.
// This adds the range check that regex cannot do: 0 <= x, y < 2^z.
function ok(r) {
    const n = Math.pow(2, Number(r.variables.tile_z));
    return Number(r.variables.tile_x) < n && Number(r.variables.tile_y) < n ? '1' : '';
}

export default { ok };
