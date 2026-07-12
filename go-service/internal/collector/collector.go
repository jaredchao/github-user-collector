// Package collector forwards requests to the collector Lambda, found through
// Cloud Map. Lambda has no IP so it can't sit behind a DNS record like the Go
// service does; instead the backend stack registers an API-type instance
// carrying the function name, and this client discovers it at call time.
package collector

import (
	"context"
	"encoding/json"
	"fmt"
	"sync"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/lambda"
	"github.com/aws/aws-sdk-go-v2/service/servicediscovery"
)

type discoverer interface {
	DiscoverInstances(ctx context.Context, in *servicediscovery.DiscoverInstancesInput, opts ...func(*servicediscovery.Options)) (*servicediscovery.DiscoverInstancesOutput, error)
}

type invoker interface {
	Invoke(ctx context.Context, in *lambda.InvokeInput, opts ...func(*lambda.Options)) (*lambda.InvokeOutput, error)
}

// Client discovers and invokes the collector Lambda.
type Client struct {
	discovery discoverer
	lambda    invoker
	namespace string
	service   string

	mu           sync.Mutex
	functionName string
	discoveredAt time.Time
}

// The function name only changes on a stack replacement, so a short cache
// avoids a DiscoverInstances round trip per request without going stale.
const discoveryTTL = 30 * time.Second

// New builds a Client from the default AWS config (task role credentials).
func New(ctx context.Context, namespace, service string) (*Client, error) {
	cfg, err := config.LoadDefaultConfig(ctx)
	if err != nil {
		return nil, fmt.Errorf("加载 AWS 配置: %w", err)
	}
	return &Client{
		discovery: servicediscovery.NewFromConfig(cfg),
		lambda:    lambda.NewFromConfig(cfg),
		namespace: namespace,
		service:   service,
	}, nil
}

func newForTest(d discoverer, i invoker, service string) *Client {
	return &Client{discovery: d, lambda: i, namespace: "zuoye.internal", service: service}
}

func (c *Client) functionNameCached(ctx context.Context) (string, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.functionName != "" && time.Since(c.discoveredAt) < discoveryTTL {
		return c.functionName, nil
	}

	out, err := c.discovery.DiscoverInstances(ctx, &servicediscovery.DiscoverInstancesInput{
		NamespaceName: aws.String(c.namespace),
		ServiceName:   aws.String(c.service),
	})
	if err != nil {
		return "", fmt.Errorf("CloudMap 发现 %s: %w", c.service, err)
	}
	for _, inst := range out.Instances {
		if name := inst.Attributes["functionName"]; name != "" {
			c.functionName = name
			c.discoveredAt = time.Now()
			return name, nil
		}
	}
	return "", fmt.Errorf("CloudMap 服务 %s 没有带 functionName 的实例", c.service)
}

// The Lambda fronts API Gateway, so a direct Invoke has to speak the same
// dialect: an API Gateway v2 event in, {statusCode, body} out.
type v2Event struct {
	Version         string            `json:"version"`
	RouteKey        string            `json:"routeKey"`
	RawPath         string            `json:"rawPath"`
	RawQueryString  string            `json:"rawQueryString"`
	Headers         map[string]string `json:"headers"`
	RequestContext  v2RequestContext  `json:"requestContext"`
	Body            string            `json:"body"`
	IsBase64Encoded bool              `json:"isBase64Encoded"`
}

type v2RequestContext struct {
	DomainName string `json:"domainName"`
	Stage      string `json:"stage"`
	HTTP       v2HTTP `json:"http"`
}

type v2HTTP struct {
	Method    string `json:"method"`
	Path      string `json:"path"`
	Protocol  string `json:"protocol"`
	SourceIP  string `json:"sourceIp"`
	UserAgent string `json:"userAgent"`
}

type v2Response struct {
	StatusCode int    `json:"statusCode"`
	Body       string `json:"body"`
}

// Forward invokes the Lambda as if the request had arrived through API
// Gateway and returns its status code and body verbatim.
func (c *Client) Forward(ctx context.Context, method, path string, body []byte) (int, []byte, error) {
	name, err := c.functionNameCached(ctx)
	if err != nil {
		return 0, nil, err
	}

	payload, err := json.Marshal(v2Event{
		Version:  "2.0",
		RouteKey: "$default",
		RawPath:  path,
		Headers:  map[string]string{"content-type": "application/json"},
		RequestContext: v2RequestContext{
			DomainName: "go-service.internal",
			Stage:      "$default",
			HTTP: v2HTTP{
				Method:    method,
				Path:      path,
				Protocol:  "HTTP/1.1",
				SourceIP:  "127.0.0.1",
				UserAgent: "zuowen-go-service",
			},
		},
		Body: string(body),
	})
	if err != nil {
		return 0, nil, err
	}

	out, err := c.lambda.Invoke(ctx, &lambda.InvokeInput{
		FunctionName: aws.String(name),
		Payload:      payload,
	})
	if err != nil {
		return 0, nil, fmt.Errorf("调用 Lambda %s: %w", name, err)
	}
	if out.FunctionError != nil {
		return 0, nil, fmt.Errorf("Lambda %s 执行错误: %s", name, aws.ToString(out.FunctionError))
	}

	var resp v2Response
	if err := json.Unmarshal(out.Payload, &resp); err != nil {
		return 0, nil, fmt.Errorf("解析 Lambda 响应: %w", err)
	}
	return resp.StatusCode, []byte(resp.Body), nil
}
