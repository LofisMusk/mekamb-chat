# Polityka bezpieczeństwa

## Status projektu

**mekamb-chat jest w budowie i nie przeszedł niezależnego audytu.**

Nie należy go używać tam, gdzie ujawnienie treści miałoby poważne konsekwencje.
Do takich zastosowań istnieją komunikatory po audycie — Signal.

## Zgłaszanie podatności

Podatności prosimy zgłaszać przez **GitHub Security Advisories** w tym
repozytorium (zakładka Security → Report a vulnerability). Kanał jest prywatny
do czasu wydania poprawki.

Prosimy **nie** zakładać publicznych zgłoszeń dla problemów bezpieczeństwa.

W zgłoszeniu przydatne są: opis, kroki odtworzenia, wersja i platforma oraz ocena
wpływu. Odpowiadamy najszybciej jak się da, ale to projekt prowadzony po
godzinach — bez gwarancji czasu reakcji.

## Zakres

Interesują nas zwłaszcza:

- obejście E2EE, wycieki materiału klucza,
- błędy w wyprowadzaniu kluczy i rozdzielaniu etykiet HKDF,
- podszycie się pod innego nadawcę,
- MITM na rozmowach (obejście weryfikacji odcisku DTLS),
- obejście uwierzytelnienia (OPAQUE, TOTP),
- panika lub uszkodzenie pamięci przy danych z sieci.

Poza zakresem — bo są udokumentowanymi decyzjami projektowymi, nie błędami:

- wyciek metadanych do serwera ([`THREAT_MODEL.md`](docs/THREAT_MODEL.md)),
- ujawnienie IP rozmówcy przy połączeniu bezpośrednim,
- utrata historii po utracie wszystkich urządzeń,
- ryzyko dostarczania kodu w kliencie webowym.

Jeśli uważasz, że któraś z tych decyzji jest błędna, załóż zwykłe zgłoszenie do
dyskusji.

## Kryptografia

Nie piszemy własnej kryptografii. Używamy:

- [OpenMLS](https://openmls.tech/) — MLS / RFC 9420
- [iroh](https://iroh.computer/) — transport QUIC
- `opaque-ke` — uwierzytelnienie hasłem bez ujawniania hasła

Pull requesty wprowadzające własne prymitywy kryptograficzne będą odrzucane.
