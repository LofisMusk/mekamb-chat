import { Component, type ErrorInfo, type ReactNode } from "react";

/**
 * Ostatnia zapora przed czarnym ekranem.
 *
 * # Czemu to musiało powstać
 *
 * Wyjątek rzucony w trakcie renderu odmontowuje **całe** drzewo Reacta.
 * Aplikacja nie pokazuje wtedy błędu — pokazuje puste, ciemne tło, bo tło jest
 * na `body`. Użytkownikowi zostaje wrażenie, że aplikacja się zawiesiła, i
 * jedyne, co może zrobić, to zgadywać.
 *
 * Zdarzyło się to naprawdę: kliknięcie rozmowy po ponownym uruchomieniu
 * wywoływało `members()` dla grupy, której nie było w odtworzonym stanie MLS.
 * Wyjątek poleciał przez render i zabrał ze sobą cały interfejs.
 *
 * Ta zapora nie naprawia przyczyny — od tego są poprawki w miejscu awarii.
 * Zapewnia tylko, że **następna** taka usterka będzie widoczna zamiast cicha.
 *
 * # Dlaczego klasa
 *
 * React nie ma haka odpowiadającego `componentDidCatch`. To jedyne miejsce
 * w tym kodzie, gdzie komponent klasowy jest jedyną możliwą formą.
 */
interface Stan {
  blad: Error | null;
}

export class Awaria extends Component<{ children: ReactNode }, Stan> {
  state: Stan = { blad: null };

  static getDerivedStateFromError(blad: Error): Stan {
    return { blad };
  }

  componentDidCatch(blad: Error, informacje: ErrorInfo): void {
    // Konsola jest tu jedynym śladem: serwer nie zbiera raportów o awariach
    // i nie będzie — nie ma czego wysyłać, skoro nie widzi nawet treści.
    console.error("awaria interfejsu", blad, informacje.componentStack);
  }

  render(): ReactNode {
    const { blad } = this.state;
    if (!blad) return this.props.children;

    return (
      <main className="aplikacja">
        <h1>Coś się posypało</h1>
        <p className="podtytul">
          Interfejs przerwał pracę. Twoje dane są na miejscu — historia i klucze
          leżą w tej przeglądarce i ta awaria ich nie dotyka.
        </p>

        <div className="karta">
          <strong>{blad.message}</strong>
          <p className="wskazowka">
            Odświeżenie zwykle wystarcza. Jeśli błąd wraca przy tej samej
            czynności, zapisz powyższą treść — mówi, co dokładnie zawiodło.
          </p>
          <button className="glowny" onClick={() => location.reload()}>
            Odśwież aplikację
          </button>
        </div>
      </main>
    );
  }
}
