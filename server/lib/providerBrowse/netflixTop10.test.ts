import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { __parseTsv } from '@server/lib/providerBrowse/netflixTop10';

const HEADER =
  'country_name\tcountry_iso2\tweek\tcategory\tweekly_rank\tshow_title\tseason_title\tcumulative_weeks_in_top_10';

describe('Netflix Top 10 TSV parser', () => {
  it('keeps only the newest week per country, sorted by rank', () => {
    const tsv = [
      HEADER,
      'Australia\tAU\t2026-09-27\tFilms\t1\tOld Film\tN/A\t3',
      'Australia\tAU\t2026-10-04\tTV\t2\tShow B\tShow B: Season 2\t1',
      'Australia\tAU\t2026-10-04\tFilms\t1\tNew Film\tN/A\t1',
      'Australia\tAU\t2026-10-04\tTV\t1\tShow A\tShow A: Limited Series\t4',
      'Canada\tCA\t2026-10-04\tFilms\t1\tCanadian Film\tN/A\t1',
      '',
    ].join('\r\n');

    const result = __parseTsv(tsv);
    const au = result.get('AU');

    assert.ok(au);
    assert.equal(au.week, '2026-10-04');
    assert.deepEqual(
      au.films.map((f) => f.showTitle),
      ['New Film']
    );
    assert.deepEqual(
      au.tv.map((t) => [t.rank, t.showTitle, t.seasonTitle]),
      [
        [1, 'Show A', 'Show A: Limited Series'],
        [2, 'Show B', 'Show B: Season 2'],
      ]
    );
    assert.equal(au.films[0].seasonTitle, '');
    assert.equal(result.get('CA')?.films.length, 1);
  });

  it('ignores malformed rows and unknown categories', () => {
    const tsv = [
      HEADER,
      'bad row',
      'X\tXX\t2026-10-04\tOther\t1\tT\tN/A\t1',
    ].join('\n');
    assert.equal(__parseTsv(tsv).size, 0);
  });
});
