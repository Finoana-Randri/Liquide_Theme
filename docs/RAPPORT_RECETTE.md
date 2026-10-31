# Rapport de compatibilité, de performance et de recette

Document à compléter sur la machine de référence. Aucune mesure n'a encore été
réalisée : les seuils ci-dessous sont les cibles du cahier des charges, pas des
résultats.

## 1. Configuration de référence

Remplir à partir de `scripts/diagnose.sh`.

| Élément | Valeur |
| --- | --- |
| Ubuntu | |
| GNOME Shell | |
| Session | |
| Ubuntu Dock (version) | |
| Processeur | |
| GPU et pilote | |
| Mémoire | |
| Écrans, résolution, échelle | |
| Extensions de flou actives | |

## 2. Points à trancher sur le prototype du dock

| Point | Méthode | Résultat |
| --- | --- | --- |
| Flou dynamique (R02) | Déplacer une fenêtre derrière le dock en mode `inset` | |
| Coins arrondis (R03) | Texte très contrasté derrière un angle ; comparer `inset` et `full` | |
| Bande non floutée en mode `inset` | Même scène, zoom sur les bords | |
| Agrandissement 1,12 | Survols rapides ; vérifier coupure et chevauchement | |
| Dock masqué | Masquage automatique ; aucun flou résiduel | |
| Activités, plein écran | Pas de dock dupliqué ni de zone qui capte les clics | |

Le mode de coins se change avec :

```bash
gsettings --schemadir ~/.local/share/gnome-shell/extensions/glass-shell@finoana-randri.github.io/schemas set org.gnome.shell.extensions.glass-shell corner-strategy 'full'
```

## 3. Protocole de mesure

Pour chaque scénario de 60 secondes : trois passages sans Glass Shell, puis
trois passages avec, profil Équilibré, mêmes fenêtres et même fond.

Scénarios :

1. Déplacer une fenêtre en continu derrière le dock.
2. Survoler les icônes du dock de gauche à droite en boucle.
3. Ouvrir et fermer les réglages rapides puis le calendrier.
4. Repos, bureau sans mouvement.

Temps de trame : enregistrer avec Sysprof (`sysprof-cli --gtk` ou l'interface
Sysprof, piste « Mutter » / « Frame timings »). Si les marques de trame ne
sont pas disponibles sur la version cible, le documenter ici et utiliser à la
place la cadence affichée par `MUTTER_DEBUG=paint` ou un protocole équivalent
validé avec le porteur du projet.

CPU au repos : relever l'utilisation de `gnome-shell` pendant 60 secondes,
deux fois à 60 secondes d'intervalle, puis après stabilisation :

```bash
pidstat -p "$(pgrep -x gnome-shell)" 1 60
```

Mémoire : après 20 cycles activation/désactivation et 30 minutes d'usage,
comparer la mémoire de `gnome-shell` et vérifier le journal :

```bash
for i in $(seq 20); do gnome-extensions disable glass-shell@finoana-randri.github.io; sleep 2; gnome-extensions enable glass-shell@finoana-randri.github.io; sleep 2; done
```

```bash
journalctl --user -b -o cat /usr/bin/gnome-shell | grep -i -E 'glass|error|critical'
```

## 4. Seuils

| Mesure | Cible | Sans effet | Avec effet | Verdict |
| --- | --- | --- | --- | --- |
| P95 temps de trame, scénario 1 | ≤ 16,7 ms, ou dégradation ≤ 10 % si la référence dépasse | | | |
| P95 temps de trame, scénario 2 | idem | | | |
| P95 temps de trame, scénario 3 | idem | | | |
| CPU gnome-shell au repos | hausse ≤ 1 point | | | |
| Mémoire après 20 cycles + 30 min | pas de croissance continue | | | |

## 5. Critères de recette

| ID | Vérification | Résultat | Preuve |
| --- | --- | --- | --- |
| R01 | Icônes Ubuntu/Yaru conservées ; aucune ressource Apple | | |
| R02 | Fenêtre en mouvement visible floutée ; icônes nettes | | |
| R03 | Ni halo rectangulaire, ni coin débordant, ni scintillement | | |
| R04 | Favoris, lancement, focus, menus, bouton applications, indicateurs | | |
| R05 | Barre, réglages rapides, calendrier, notifications | | |
| R06 | Réglages conservés après reconnexion ; clair, sombre, système | | |
| R07 | Activités, plein écran, écran ajouté ou retiré, veille | | |
| R08 | Clavier, focus, effets réduits, lisibilité sur plusieurs fonds | | |
| R09 | Protocole et seuils de la section 4 | | |
| R10 | Installation répétée, désactivation, désinstallation | | |
| R11 | 20 cycles sans fuite ; aucune erreur du projet en 30 minutes | | |
| R12 | Lint réussi, commentaires en anglais, construction reproductible | | |

## 6. Jeu de captures

Pour les modes clair et sombre, sur fond blanc, noir, coloré et photographie
chargée : dock au repos, au survol, avec une application active, avec un
panneau ouvert. Ajouter une capture avec du texte très contrasté derrière le
verre.
