import nextjs from '@portal/config/eslint/nextjs';
export default [...nextjs, { ignores: ['.next/**', '.next-dev/**', 'out/**', 'next-env.d.ts'] }];
