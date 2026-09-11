import nextjs from '@portal/config/eslint/nextjs';
export default [...nextjs, { ignores: ['.next/**', 'next-env.d.ts'] }];
