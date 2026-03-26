export async function parseJsonResponse(response, fallbackMessage = 'Request failed') {
  const contentType = response.headers.get('content-type') || '';
  const isJson = contentType.includes('application/json');

  if (!isJson) {
    const text = await response.text();
    const message = text ? `Server returned ${response.status}: ${text.substring(0, 100)}` : fallbackMessage;
    const error = new Error(message);
    error.status = response.status;
    error.responseText = text;
    throw error;
  }

  const data = await response.json();

  if (!response.ok) {
    const message = data?.error || fallbackMessage;
    const error = new Error(message);
    error.status = response.status;
    error.data = data;
    throw error;
  }

  return data;
}

export async function requestJson(url, options = {}, fallbackMessage = 'Request failed') {
  const response = await fetch(url, options);
  const data = await parseJsonResponse(response, fallbackMessage);
  return { response, data };
}
