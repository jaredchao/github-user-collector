package collector

import (
	"context"
	"encoding/json"
	"errors"
	"testing"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/lambda"
	"github.com/aws/aws-sdk-go-v2/service/servicediscovery"
	sdtypes "github.com/aws/aws-sdk-go-v2/service/servicediscovery/types"
)

type fakeDiscoverer struct {
	function string
	err      error
	calls    int
}

func (f *fakeDiscoverer) DiscoverInstances(ctx context.Context, in *servicediscovery.DiscoverInstancesInput, _ ...func(*servicediscovery.Options)) (*servicediscovery.DiscoverInstancesOutput, error) {
	f.calls++
	if f.err != nil {
		return nil, f.err
	}
	return &servicediscovery.DiscoverInstancesOutput{
		Instances: []sdtypes.HttpInstanceSummary{
			{Attributes: map[string]string{"functionName": f.function}},
		},
	}, nil
}

type fakeInvoker struct {
	gotFunction string
	gotPayload  []byte
	response    []byte
	err         error
}

func (f *fakeInvoker) Invoke(ctx context.Context, in *lambda.InvokeInput, _ ...func(*lambda.Options)) (*lambda.InvokeOutput, error) {
	f.gotFunction = aws.ToString(in.FunctionName)
	f.gotPayload = in.Payload
	if f.err != nil {
		return nil, f.err
	}
	return &lambda.InvokeOutput{StatusCode: 200, Payload: f.response}, nil
}

func lambdaResponse(t *testing.T, status int, body string) []byte {
	t.Helper()
	b, err := json.Marshal(map[string]any{"statusCode": status, "body": body})
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func TestForward_PassesThroughStatusAndBody(t *testing.T) {
	inv := &fakeInvoker{response: lambdaResponse(t, 201, `{"username":"torvalds"}`)}
	c := newForTest(&fakeDiscoverer{function: "fn-abc"}, inv, "collector-lambda")

	status, body, err := c.Forward(context.Background(), "POST", "/users", []byte(`{"username":"torvalds"}`))
	if err != nil {
		t.Fatalf("Forward 出错: %v", err)
	}
	if status != 201 || string(body) != `{"username":"torvalds"}` {
		t.Errorf("status=%d body=%s, 期望 201 与原样透传", status, body)
	}
	if inv.gotFunction != "fn-abc" {
		t.Errorf("调用了 %q, 期望 CloudMap 发现的 fn-abc", inv.gotFunction)
	}
}

func TestForward_BuildsAPIGatewayV2Event(t *testing.T) {
	inv := &fakeInvoker{response: lambdaResponse(t, 200, "{}")}
	c := newForTest(&fakeDiscoverer{function: "fn"}, inv, "collector-lambda")

	if _, _, err := c.Forward(context.Background(), "POST", "/users", []byte(`{"a":1}`)); err != nil {
		t.Fatal(err)
	}

	var event map[string]any
	if err := json.Unmarshal(inv.gotPayload, &event); err != nil {
		t.Fatalf("载荷不是 JSON: %v", err)
	}
	if event["version"] != "2.0" || event["rawPath"] != "/users" || event["body"] != `{"a":1}` {
		t.Errorf("事件字段不对: %v", event)
	}
	http := event["requestContext"].(map[string]any)["http"].(map[string]any)
	if http["method"] != "POST" {
		t.Errorf("method = %v, 期望 POST", http["method"])
	}
}

func TestForward_DiscoveryResultIsCached(t *testing.T) {
	disc := &fakeDiscoverer{function: "fn"}
	c := newForTest(disc, &fakeInvoker{response: lambdaResponse(t, 200, "{}")}, "collector-lambda")

	for range 3 {
		if _, _, err := c.Forward(context.Background(), "POST", "/users", nil); err != nil {
			t.Fatal(err)
		}
	}
	if disc.calls != 1 {
		t.Errorf("DiscoverInstances 调了 %d 次, 期望缓存后只调 1 次", disc.calls)
	}
}

func TestForward_DiscoveryFailure(t *testing.T) {
	c := newForTest(&fakeDiscoverer{err: errors.New("boom")}, &fakeInvoker{}, "collector-lambda")
	if _, _, err := c.Forward(context.Background(), "POST", "/users", nil); err == nil {
		t.Error("发现失败应返回错误")
	}
}
