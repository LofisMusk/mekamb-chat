-- Zużyte tokeny doręczeniowe.
--
-- Token jest jednorazowy: bez tej tabeli jeden wydany token wystarczyłby na
-- dowolną liczbę nadań i cała ochrona przed zalewaniem skrzynek byłaby pozorna.
--
-- Klucz główny na ziarnie daje atomowość za darmo — drugie nadanie tego samego
-- tokenu odpada na naruszeniu unikalności, bez odczytu i zapisu w dwóch krokach,
-- między którymi zmieściłby się wyścig.
--
-- W tabeli NIE MA nic o nadawcy i nie może się pojawić: gdyby było, serwer
-- odzyskałby dokładnie tę informację, którą cały schemat ukrywa.
CREATE TABLE IF NOT EXISTS spent_tokens (
  seed       TEXT PRIMARY KEY,
  spent_at   INTEGER NOT NULL
);

-- Do sprzątania starych wpisów. Bez indeksu kasowanie po czasie skanowałoby
-- całą tabelę, która rośnie z każdą wysłaną wiadomością.
CREATE INDEX IF NOT EXISTS spent_tokens_spent_at ON spent_tokens (spent_at);
