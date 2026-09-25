'use client';

import * as React from 'react';
import { NumbersNavContext } from '@/src/components/dashboard/numbers/number-bits';
import { NumberDetail } from '@/src/components/dashboard/numbers/number-detail';
import { NumbersList } from '@/src/components/dashboard/numbers/numbers-list';
import { setParam, useUrlQuery } from '@/src/lib/use-url-query';

/**
 * D4 Numbers (spec pp. 36–37). `/app/numbers/` is the list; `/app/numbers/?id=&tab=` is
 * one number (the spec's `/app/numbers/[id]`, flattened for the static export like D3).
 */
export default function NumbersPage() {
  const [params, setParams] = useUrlQuery();
  const id = params.get('id');
  const nav = React.useMemo(
    () => ({
      open: (numberId: string, tab?: string) =>
        setParams((next) => {
          next.delete('tab');
          next.set('id', numberId);
          setParam(next, 'tab', tab && tab !== 'routing' ? tab : null);
        }),
      list: () =>
        setParams((next) => {
          next.delete('id');
          next.delete('tab');
        }),
    }),
    [setParams],
  );
  // Braces matter: Chrome's `scrollTo` returns a Promise, and an effect must return nothing but a clean-up.
  React.useEffect(() => {
    window.scrollTo({ top: 0 });
  }, [id]);

  return (
    <NumbersNavContext.Provider value={nav}>
      {id ? (
        <NumberDetail
          key={id}
          id={id}
          tab={params.get('tab')}
          onTab={(tab) =>
            setParams((next) => {
              setParam(next, 'tab', tab === 'routing' ? null : tab);
            }, 'replace')
          }
        />
      ) : (
        <NumbersList />
      )}
    </NumbersNavContext.Provider>
  );
}
