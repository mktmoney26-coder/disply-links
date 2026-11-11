#!/bin/bash
# Decide se a Vercel publica este projeto (saída 1 = publica, 0 = pula).
# O projeto principal (tem STATS_KEY) sempre publica. Os projetos antigos de BM (só servem os links)
# só publicam quando muda algo que os links usam — assim não gastam o limite diário de publicações.
if [ -n "$STATS_KEY" ]; then exit 1; fi
if [ -z "$VERCEL_GIT_PREVIOUS_SHA" ]; then exit 1; fi
git diff --quiet "$VERCEL_GIT_PREVIOUS_SHA" HEAD -- api/go.js api/img.js lib/db.js links.json vercel.json package.json public 2>/dev/null
if [ $? -eq 0 ]; then echo "Sem mudanças nos links: pulando."; exit 0; fi
exit 1
