const fs = require('fs');
const path = require('path');
const SwaggerParser = require('@apidevtools/swagger-parser');

const serverPath = path.join(__dirname, 'server.js');
const specPath = path.join(__dirname, 'openapi.json');
const serverSource = fs.readFileSync(serverPath, 'utf8');
const routePattern = /^app\.(get|post|put|patch|delete)\(\s*'([^']+)'/gm;
const routes = new Set();

for (const match of serverSource.matchAll(routePattern)) {
    const [, method, expressPath] = match;
    if (expressPath === '*') continue;
    const openApiPath = expressPath.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
    routes.add(`${method.toLowerCase()} ${openApiPath}`);
}

function isImplementedByMiddleware(method, openApiPath) {
    if (method !== 'get') return false;
    if (openApiPath === '/') return serverSource.includes('app.use(express.static(__dirname))');
    if (openApiPath === '/api-docs') return serverSource.includes("app.use('/api-docs', swaggerUi.serve");
    return false;
}

async function validateRoutes() {
    const spec = await SwaggerParser.validate(specPath);
    const documentedRoutes = new Set();

    for (const [openApiPath, pathItem] of Object.entries(spec.paths)) {
        for (const method of ['get', 'post', 'put', 'patch', 'delete']) {
            if (!pathItem[method]) continue;
            const routeKey = `${method} ${openApiPath}`;
            documentedRoutes.add(routeKey);
            if (!routes.has(routeKey) && !isImplementedByMiddleware(method, openApiPath)) {
                throw new Error(`OpenAPI documenta uma rota inexistente: ${routeKey}`);
            }
        }
    }

    const undocumentedRoutes = [...routes].filter(route => !documentedRoutes.has(route));
    if (undocumentedRoutes.length) {
        throw new Error(`Rotas sem documentação OpenAPI: ${undocumentedRoutes.join(', ')}`);
    }

    console.log(`OpenAPI ${spec.openapi} válido: ${documentedRoutes.size} operações documentadas e correspondentes ao servidor.`);
}

validateRoutes().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
});
