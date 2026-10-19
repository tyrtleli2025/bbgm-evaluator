# Fixed league fixture

`league.json.gz` is a compact fixture derived from the supplied 2006 preseason
export. It retains simulation settings and the 458 rostered players' current
ratings, identities, contracts, availability, rotation values and birth years.
Historical player records and statistics are omitted. Compression has a fixed
timestamp. Tests use this fixture so replacing working league exports does not
change their input or make them fail because an old export was deleted.
