import axios from "axios";

export function sendEvolution(serverUrl: string, instance: string, apiKey: string, action: "sendText" | "sendMedia", payload: object) {
  return axios.post(`${serverUrl.replace(/\/$/,"")}/message/${action}/${encodeURIComponent(instance)}`, payload, {
    headers: { apikey: apiKey, "Content-Type": "application/json" },
    timeout: 15000,
    maxRedirects: 0,
  });
}
