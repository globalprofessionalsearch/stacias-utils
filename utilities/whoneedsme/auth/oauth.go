package auth

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"fmt"
	"io"
	"log"
	"math/big"
	"net"
	"net/http"
	"os/exec"
	"runtime"
	"time"

	"golang.org/x/oauth2"
)

const CallbackPort = 9119

// RunFlow opens the browser for OAuth with PKCE and captures the callback token.
// Uses port 9119 for the local HTTPS callback server (must be registered in the OAuth app).
func RunFlow(ctx context.Context, conf *oauth2.Config, state string, opts ...oauth2.AuthCodeOption) (*oauth2.Token, error) {
	return RunFlowWithOpener(ctx, conf, state, openBrowser, CallbackPort, opts...)
}

// RunFlowWithOpener is like RunFlow but accepts a custom opener and port.
// Pass port=0 to use a random available port (useful in tests).
func RunFlowWithOpener(
	ctx context.Context,
	conf *oauth2.Config,
	state string,
	opener func(string) error,
	port int,
	opts ...oauth2.AuthCodeOption,
) (*oauth2.Token, error) {
	verifier := oauth2.GenerateVerifier()

	cert, err := generateSelfSignedCert()
	if err != nil {
		return nil, fmt.Errorf("generate TLS cert: %w", err)
	}

	addr := fmt.Sprintf("127.0.0.1:%d", port)
	listener, err := net.Listen("tcp", addr)
	if err != nil {
		return nil, fmt.Errorf("start local server: %w", err)
	}
	listenPort := listener.Addr().(*net.TCPAddr).Port
	conf.RedirectURL = fmt.Sprintf("https://localhost:%d/callback", listenPort)

	codeCh := make(chan string, 1)
	errCh := make(chan error, 1)

	mux := http.NewServeMux()
	mux.HandleFunc("/callback", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("state") != state {
			errCh <- fmt.Errorf("state mismatch in OAuth callback")
			http.Error(w, "invalid state", http.StatusBadRequest)
			return
		}
		code := r.URL.Query().Get("code")
		if code == "" {
			errCh <- fmt.Errorf("no code in callback")
			http.Error(w, "authentication failed", http.StatusBadRequest)
			return
		}
		fmt.Fprintln(w, "Authentication successful! You can close this tab.")
		codeCh <- code
	})

	srv := &http.Server{
		Handler: mux,
		TLSConfig: &tls.Config{
			Certificates: []tls.Certificate{cert},
		},
		// Suppress TLS handshake errors from Chrome's background requests
		// rejecting the self-signed cert — expected and harmless.
		ErrorLog: log.New(io.Discard, "", 0),
	}
	go srv.ServeTLS(listener, "", "") //nolint:errcheck
	defer srv.Shutdown(context.Background()) //nolint:errcheck

	allOpts := append([]oauth2.AuthCodeOption{
		oauth2.AccessTypeOffline,
		oauth2.S256ChallengeOption(verifier),
	}, opts...)
	authURL := conf.AuthCodeURL(state, allOpts...)
	if err := opener(authURL); err != nil {
		fmt.Printf("Open this URL in your browser:\n%s\n", authURL)
	}

	select {
	case code := <-codeCh:
		return conf.Exchange(ctx, code, oauth2.VerifierOption(verifier))
	case err := <-errCh:
		return nil, err
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

// generateSelfSignedCert creates an in-memory self-signed TLS certificate for
// localhost. Used to satisfy OAuth providers that require HTTPS redirect URIs.
func generateSelfSignedCert() (tls.Certificate, error) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return tls.Certificate{}, err
	}
	template := x509.Certificate{
		SerialNumber: big.NewInt(1),
		Subject:      pkix.Name{},
		NotBefore:    time.Now().Add(-time.Minute),
		NotAfter:     time.Now().Add(time.Hour),
		IPAddresses:  []net.IP{net.ParseIP("127.0.0.1")},
		DNSNames:     []string{"localhost"},
	}
	certDER, err := x509.CreateCertificate(rand.Reader, &template, &template, &key.PublicKey, key)
	if err != nil {
		return tls.Certificate{}, err
	}
	keyDER, err := x509.MarshalECPrivateKey(key)
	if err != nil {
		return tls.Certificate{}, err
	}
	certPEM := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: certDER})
	keyPEM := pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: keyDER})
	return tls.X509KeyPair(certPEM, keyPEM)
}

func openBrowser(url string) error {
	switch runtime.GOOS {
	case "darwin":
		return exec.Command("open", url).Start()
	case "linux":
		return exec.Command("xdg-open", url).Start()
	default:
		return fmt.Errorf("unsupported OS: %s", runtime.GOOS)
	}
}
