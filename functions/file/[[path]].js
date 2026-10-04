// Redirect old /file/ paths to /OvO/ for backwards compatibility
export async function onRequest(context) {
    const url = new URL(context.request.url);
    const newPath = url.pathname.replace(/^\/file\//, '/OvO/');
    return Response.redirect(`${url.origin}${newPath}${url.search}`, 301);
}
