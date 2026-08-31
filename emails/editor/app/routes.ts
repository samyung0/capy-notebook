import { index, type RouteConfig, route } from '@react-router/dev/routes';

export default [
  index('routes/_index.tsx'),
  route('api/preview', 'routes/api.preview.ts'),
  route(
    'api/templates/:templateId/:locale',
    'routes/api.templates.$templateId.$locale.ts'
  ),
] satisfies RouteConfig;
