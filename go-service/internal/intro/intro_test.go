package intro

import (
	"strconv"
	"strings"
	"testing"
	"time"
)

func ptr(s string) *string { return &s }

func date(year int) *time.Time {
	t := time.Date(year, 1, 1, 0, 0, 0, 0, time.UTC)
	return &t
}

func TestBuild_AllFields(t *testing.T) {
	got := Build(User{
		Username:      "torvalds",
		Name:          ptr("Linus Torvalds"),
		Company:       ptr("Linux Foundation"),
		Location:      ptr("Portland, OR"),
		PublicRepos:   12,
		Followers:     310967,
		GitHubCreated: date(2011),
	})

	age := time.Now().Year() - 2011
	for _, want := range []string{
		"Linus Torvalds", "@torvalds", "来自 Portland, OR",
		"就职于 Linux Foundation", "12 个公开仓库", "310967 位关注者",
		"注册于 2011 年", "至今已 " + strconv.Itoa(age) + " 年",
	} {
		if !strings.Contains(got, want) {
			t.Errorf("缺少片段 %q\n完整输出: %s", want, got)
		}
	}
}

func TestBuild_MissingCompanyAndLocation(t *testing.T) {
	got := Build(User{
		Username:    "octocat",
		Name:        ptr("The Octocat"),
		PublicRepos: 8,
		Followers:   5000,
	})

	if strings.Contains(got, "来自") || strings.Contains(got, "就职于") {
		t.Errorf("空字段不该出现地点/公司句: %s", got)
	}
	if strings.Contains(got, "<nil>") {
		t.Errorf("不该渲染出 <nil>: %s", got)
	}
	if !strings.Contains(got, "The Octocat（@octocat）") {
		t.Errorf("主句错误: %s", got)
	}
}

func TestBuild_NameFallsBackToUsername(t *testing.T) {
	got := Build(User{Username: "ghost", PublicRepos: 0, Followers: 0})

	if !strings.HasPrefix(got, "ghost（@ghost）") {
		t.Errorf("name 为空应回落到 username: %s", got)
	}
}

func TestBuild_EmptyStringTreatedAsMissing(t *testing.T) {
	// A present-but-blank column should behave like NULL.
	got := Build(User{
		Username:    "blank",
		Name:        ptr("   "),
		Location:    ptr(""),
		PublicRepos: 1,
		Followers:   2,
	})

	if !strings.HasPrefix(got, "blank（@blank）") {
		t.Errorf("空白 name 应回落到 username: %s", got)
	}
	if strings.Contains(got, "来自") {
		t.Errorf("空 location 不该出现地点句: %s", got)
	}
}

func TestBuild_WithBio(t *testing.T) {
	got := Build(User{
		Username:    "dev",
		Bio:         ptr("I build things"),
		PublicRepos: 3,
		Followers:   10,
	})

	if !strings.Contains(got, "I build things") {
		t.Errorf("应包含 bio: %s", got)
	}
}

func TestBuild_NoGitHubCreatedOmitsRegistration(t *testing.T) {
	got := Build(User{Username: "x", PublicRepos: 1, Followers: 1})

	if strings.Contains(got, "注册于") {
		t.Errorf("无注册时间不该出现注册句: %s", got)
	}
}

func TestBuild_AccountCreatedThisYearOmitsAge(t *testing.T) {
	now := time.Now()
	got := Build(User{Username: "newbie", GitHubCreated: &now})
	if strings.Contains(got, "至今已") {
		t.Errorf("注册当年不应输出账龄\n完整输出: %s", got)
	}
}
