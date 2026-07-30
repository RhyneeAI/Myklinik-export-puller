import axios from 'axios';
import { wrapper } from 'axios-cookiejar-support';
import { CookieJar } from 'tough-cookie';
import dotenv from 'dotenv';

dotenv.config();

const ENDPOINT_URL = process.env.ENDPOINT_URL;

if (!ENDPOINT_URL) {
  throw new Error('ENDPOINT_URL is required in .env');
}

export const jar = new CookieJar();

export const http = wrapper(axios.create({
  baseURL: ENDPOINT_URL,
  jar,
  withCredentials: true,
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    Accept: '*/*',
  },
  maxRedirects: 5,
  validateStatus: (status) => status >= 200 && status < 400,
}));
