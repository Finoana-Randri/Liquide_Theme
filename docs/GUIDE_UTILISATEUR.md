# Glass Shell — guide utilisateur

Glass Shell donne au dock Ubuntu et à la barre supérieure de GNOME un effet de
verre : l'arrière-plan est flouté, la surface est légèrement teintée et
bordée d'un liseré fin. Vos icônes Ubuntu restent les mêmes.

## Avant d'installer

Ouvrez un terminal dans le dossier du projet et lancez :

```bash
scripts/diagnose.sh
```

Le rapport indique la version de GNOME, le type de session, le dock actif, la
carte graphique, les écrans et les éventuelles extensions de flou. La
configuration de référence est Ubuntu, GNOME 46 à 50, session Wayland et
Ubuntu Dock.

## Installer

```bash
scripts/install.sh
```

Sous Wayland, GNOME ne découvre une nouvelle extension qu'à la connexion :
fermez la session, reconnectez-vous, puis activez l'extension :

```bash
gnome-extensions enable glass-shell@finoana-randri.github.io
```

Au premier lancement, le dock est placé en bas et centré. Les anciennes
valeurs du dock sont sauvegardées pour pouvoir les remettre plus tard.

## Apparence façon macOS (icônes, fenêtres, curseurs)

```bash
scripts/install-appearance.sh --color light
```

Le script installe pour votre utilisateur les icônes, les curseurs et le
thème des fenêtres WhiteSur (projet libre aux dessins originaux), place les
boutons des fenêtres à gauche et utilise la police Inter si elle est
installée (`sudo apt install fonts-inter`). Remplacez `light` par `dark` pour
la variante sombre. Les anciens réglages sont sauvegardés ; pour revenir en
arrière :

```bash
scripts/install-appearance.sh --restore
```

## Régler

```bash
gnome-extensions prefs glass-shell@finoana-randri.github.io
```

La fenêtre de préférences comporte quatre rubriques. Les changements
s'appliquent tout de suite et sont conservés à la connexion suivante.

**Apparence** — mode Système, Clair ou Sombre ; opacité des teintes claire et
sombre ; intensité du flou ; rayon des angles ; intensité des reflets.

**Dock** — préréglage bas et centré ; taille des icônes (32 à 64) ;
espacement ; marge intérieure ; marge au bord de l'écran ; agrandissement au
survol. Le bouton « Ouvrir » donne accès aux réglages d'Ubuntu Dock (masquage
automatique, écran utilisé, etc.).

**Surfaces** — activez ou désactivez séparément le dock, la barre supérieure,
les réglages rapides, le menu calendrier, les autres menus (barre, clic droit
du dock, aperçus de fenêtres), les bannières de notification, l'affichage du
volume et le sélecteur Alt+Tab. « Barre de bureau fine » affine la barre
supérieure, place l'horloge à droite et les notifications en haut à droite.

**Performance** — profils Qualité, Équilibré (par défaut) et Économie ; effets
réduits ; transparence réduite. La rubrique Maintenance permet de rétablir les
réglages de Glass Shell, de remettre les réglages d'origine du dock et de
consulter les messages de compatibilité.

## Accessibilité

- Si les animations sont désactivées dans GNOME, l'agrandissement au survol
  est coupé et les transitions sont instantanées.
- Avec le contraste élevé, les surfaces deviennent presque opaques.
- « Effets réduits » retire le flou, les reflets et l'agrandissement.
- La barre, les menus et les notifications gardent une teinte minimale pour
  que le texte reste lisible.

## En cas de problème

Désactiver l'extension :

```bash
gnome-extensions disable glass-shell@finoana-randri.github.io
```

Si le bureau devient difficile à utiliser : appuyez sur Ctrl+Alt+F3,
connectez-vous dans la console texte, puis désactivez toutes les extensions
utilisateur :

```bash
gsettings set org.gnome.shell disable-user-extensions true
```

Revenez à la session graphique avec Ctrl+Alt+F2 (ou F1) et reconnectez-vous.
Remplacez `true` par `false` pour réactiver les extensions.

Si une autre extension de flou (par exemple Blur my Shell) floute déjà une
surface, Glass Shell laisse cette surface telle quelle et l'indique dans
Performance → Compatibilité et conflits. Désactivez le flou de cette surface
dans l'autre extension pour que Glass Shell la prenne en charge.

## Désinstaller

```bash
scripts/uninstall.sh
```

Le script remet les réglages du dock d'avant Glass Shell, sauf ceux que vous
avez modifiés entre-temps, puis supprime l'extension. Ajoutez `--purge` pour
effacer aussi les préférences de Glass Shell. Sous Wayland, déconnectez-vous
pour que le changement soit complet.
