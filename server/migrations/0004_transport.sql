-- Przejście z iroh na własny transport (UDP + Noise).
--
-- Zmienia się to, co katalog przechowuje o urządzeniu: zamiast identyfikatora
-- węzła iroh trzymamy klucz publiczny warstwy transportowej i listę adresów,
-- pod którymi urządzenie jest osiągalne.
--
-- Serwer nadal NIE jest zaufanym źródłem tych danych: gdyby podał obcy klucz,
-- handshake Noise po stronie klienta by nie przeszedł.

ALTER TABLE devices RENAME COLUMN iroh_node_id TO transport_key;

-- Adresy rozdzielone przecinkami, np. „192.168.1.5:41234,203.0.113.7:41234".
-- Pusta wartość znaczy „osiągalny wyłącznie przez skrzynkę" — tak wygląda
-- każda przeglądarka.
ALTER TABLE devices RENAME COLUMN addr_record TO transport_addresses;
