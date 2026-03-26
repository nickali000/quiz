# Usa un'immagine leggera basata su Alpine
FROM node:20-alpine

# Imposta la directory di lavoro
WORKDIR /app

# Copia package.json e package-lock.json per sfruttare la cache di Docker
COPY package*.json ./

# Installa le dipendenze di produzione
RUN npm ci --omit=dev

# Copia il resto dell'applicazione
COPY . .

# Cambia il proprietario della directory al built-in 'node' user per sicurezza
RUN chown -R node:node /app

# Esegui l'app come utente non root
USER node

# Imposta variabili d'ambiente di default
ENV PORT=1111
ENV NODE_ENV=production

# Esponi la porta
EXPOSE 1111

# Aggiungi un healthcheck per monitorare lo stato dell'app
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget --quiet --tries=1 --spider http://localhost:1111/api/health || exit 1

# Comando per avviare l'app
CMD ["npm", "start"]
