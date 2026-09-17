-- ALTER TABLE ... TYPE in 005 dropped column-level privileges. Regrant them.
GRANT SELECT, INSERT ON claims TO clptr4p_capture;
GRANT UPDATE (superseded_by, valid_to, embedding) ON claims TO clptr4p_capture;
