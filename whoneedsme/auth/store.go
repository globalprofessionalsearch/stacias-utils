package auth

import (
	"os"
	"path/filepath"
	"time"

	"golang.org/x/oauth2"
	"gopkg.in/yaml.v3"
)

// SourceConfig holds token and settings for one source.
// Credentials (client ID/secret) are embedded in the binary at build time — not stored here.
type SourceConfig struct {
	CloudID        string     `yaml:"cloud_id,omitempty"`
	TimeoutSeconds int        `yaml:"timeout_seconds"`
	Token          *TokenData `yaml:"token,omitempty"`
}

// TokenData is the persisted form of an oauth2.Token.
type TokenData struct {
	AccessToken  string    `yaml:"access_token"`
	TokenType    string    `yaml:"token_type"`
	RefreshToken string    `yaml:"refresh_token"`
	Expiry       time.Time `yaml:"expiry"`
}

type configFile struct {
	Sources map[string]*SourceConfig `yaml:"sources"`
}

// Store loads and saves the whoneedsme config file.
type Store struct {
	path string
	cfg  configFile
}

// NewStore creates a Store backed by the default config path (~/.config/whoneedsme/config.yaml).
func NewStore() (*Store, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return nil, err
	}
	return NewStoreAt(filepath.Join(home, ".config", "whoneedsme", "config.yaml"))
}

// NewStoreAt creates a Store backed by an explicit path. Used in tests.
func NewStoreAt(path string) (*Store, error) {
	s := &Store{path: path, cfg: configFile{Sources: make(map[string]*SourceConfig)}}
	if err := s.load(); err != nil {
		return nil, err
	}
	return s, nil
}

func (s *Store) load() error {
	data, err := os.ReadFile(s.path)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return err
	}
	return yaml.Unmarshal(data, &s.cfg)
}

func (s *Store) save() error {
	if err := os.MkdirAll(filepath.Dir(s.path), 0700); err != nil {
		return err
	}
	data, err := yaml.Marshal(&s.cfg)
	if err != nil {
		return err
	}
	return os.WriteFile(s.path, data, 0600)
}

// GetSourceConfig returns the config for a named source.
func (s *Store) GetSourceConfig(name string) (*SourceConfig, bool) {
	cfg, ok := s.cfg.Sources[name]
	return cfg, ok
}

// SetToken stores an OAuth token for a source, creating the source entry if needed.
func (s *Store) SetToken(source string, token *oauth2.Token) error {
	if s.cfg.Sources[source] == nil {
		s.cfg.Sources[source] = &SourceConfig{TimeoutSeconds: 30}
	}
	s.cfg.Sources[source].Token = &TokenData{
		AccessToken:  token.AccessToken,
		TokenType:    token.TokenType,
		RefreshToken: token.RefreshToken,
		Expiry:       token.Expiry,
	}
	return s.save()
}

// GetToken returns the stored OAuth token for a source, if present.
func (s *Store) GetToken(source string) (*oauth2.Token, bool) {
	cfg, ok := s.cfg.Sources[source]
	if !ok || cfg.Token == nil {
		return nil, false
	}
	return &oauth2.Token{
		AccessToken:  cfg.Token.AccessToken,
		TokenType:    cfg.Token.TokenType,
		RefreshToken: cfg.Token.RefreshToken,
		Expiry:       cfg.Token.Expiry,
	}, true
}

// SetCloudID stores the JIRA cloud ID for a source, creating the source entry if needed.
func (s *Store) SetCloudID(source, cloudID string) error {
	if s.cfg.Sources[source] == nil {
		s.cfg.Sources[source] = &SourceConfig{TimeoutSeconds: 30}
	}
	s.cfg.Sources[source].CloudID = cloudID
	return s.save()
}
