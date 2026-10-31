import type { BaseLayoutProps } from 'fumadocs-ui/layouts/shared';
import { CalderaLogo } from '@/components/caldera-logo';

export function baseOptions(): BaseLayoutProps {
  return {
    nav: {
      title: <CalderaLogo className="h-5 w-auto" />,
    },
    links: [{ text: 'Docs', url: '/docs', active: 'nested-url' }],
  };
}
