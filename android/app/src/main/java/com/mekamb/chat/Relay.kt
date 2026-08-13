package com.mekamb.chat

/**
 * Co zrobić z przygotowanym commitem, gdy relay go nie przyjął.
 *
 * # Czemu to musiało powstać
 *
 * Commit przygotowany (`stage_add_members`) i **nieporzucony** blokuje w MLS
 * całą rozmowę, nie tylko dodawanie: kolejna zmiana składu i zwykłe wysłanie
 * wiadomości kończą się wtedy „Can't execute operation because a pending commit
 * exists". Klient, który przy odmowie relaya tylko pokaże błąd, zostawia
 * rozmowę zepsutą aż do restartu aplikacji — a użytkownik widzi to jako
 * „przestało wysyłać", bez żadnego związku z tym, co robił chwilę wcześniej.
 *
 * Tak wyglądała usterka #18. Wdrożony Worker był starszy niż klienci i odmawiał
 * zajęcia epoki (`400`), więc pierwsza próba dodania kontaktu kończyła się
 * komunikatem serwera, a każda następna czynność w tej rozmowie — komunikatem
 * o oczekującym commicie.
 *
 * # Reguła
 *
 * Odmowa, o której wiemy, że relay epoki NIE zajął, kończy się porzuceniem
 * commitu. Odpowiedź, której nie umiemy rozstrzygnąć, nie zmienia niczego.
 *
 * Ta sama reguła obowiązuje w kliencie webowym (`web/src/lib/relay.ts`).
 * Rozjazd znaczyłby, że ta sama odmowa zostawia dwa różne stany na dwóch
 * urządzeniach jednego konta.
 */
object Relay {

    /**
     * Przegrany wyścig o epokę — jedyna odmowa, którą relay wystawia sam z siebie.
     *
     * Wydzielony, bo ta sama sytuacja przychodzi dwiema drogami: kodem 409
     * i odpowiedzią `200` z `accepted: false`.
     */
    const val WYSCIG = "Ktoś zmienił skład tej rozmowy w tej samej chwili. Spróbuj jeszcze raz."

    /**
     * Rozstrzyga odmowę na podstawie kodu odpowiedzi.
     *
     * Zwrócony tekst znaczy: **epoka na pewno nie została zajęta**, więc commit
     * ma zostać porzucony, a to zdanie — pokazane użytkownikowi. Nie ma tu
     * drugiego pola „czy porzucić": każda rozstrzygalna odmowa kończy się
     * porzuceniem, a pole zawsze prawdziwe udawałoby wybór, którego nie ma.
     *
     * `null` znaczy „nie wiadomo": 5xx i brak sieci nie mówią, czy relay zdążył
     * epokę zająć, zanim przestał odpowiadać. Porzucenie commitu byłoby wtedy
     * zgadywaniem — wołający ma przekazać błąd dalej i nie ruszać stanu MLS.
     */
    fun odmowa(status: Int): String? = when {
        // Wyścig: ktoś zdążył pierwszy, epoka jest już zajęta jego commitem.
        // Nasz trzeba porzucić, przetworzyć cudzy (dojdzie skrzynką) i ponowić.
        status == 409 -> WYSCIG

        // Wygasła sesja jest zwykłym stanem, nie awarią — i ma inne wyjście niż
        // „spróbuj ponownie", więc nie może chować się pod komunikatem o serwerze.
        status == 401 || status == 403 ->
            "Sesja wygasła. Zaloguj się ponownie i powtórz tę zmianę."

        // Pozostałe odmowy klienta: żądanie w ogóle nie doszło do relaya, więc
        // epoka została nietknięta. W praktyce znaczy to serwer w innej wersji
        // niż aplikacja — i tylko to warto powiedzieć, bo użytkownik nic innego
        // z tym nie zrobi.
        status in 400..499 ->
            "Serwer nie przyjął zmiany składu rozmowy — najpewniej działa " +
                "w starszej wersji niż ta aplikacja. Spróbuj ponownie, gdy zostanie " +
                "zaktualizowany."

        else -> null
    }
}
