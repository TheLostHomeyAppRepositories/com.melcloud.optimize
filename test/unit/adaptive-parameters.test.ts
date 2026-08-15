/**
 * Unit tests for AdaptiveParametersLearner
 * 
 * Tests the learning system that adapts optimization strategy parameters
 * based on comfort vs savings outcomes.
 */

import { AdaptiveParametersLearner, AdaptiveParameters } from '../../src/services/adaptive-parameters';

// Mock Homey settings storage
function createMockHomey(storedParams?: Partial<AdaptiveParameters>) {
    const storage: Record<string, string> = {};

    if (storedParams) {
        storage['adaptive_business_parameters'] = JSON.stringify(storedParams);
    }

    return {
        settings: {
            get: jest.fn((key: string) => storage[key] || null),
            set: jest.fn((key: string, value: string) => {
                storage[key] = value;
            })
        },
        log: jest.fn(),
        error: jest.fn()
    };
}

describe('AdaptiveParametersLearner', () => {
    describe('initialization', () => {
        test('uses DEFAULT_PARAMETERS when settings empty', () => {
            const mockHomey = createMockHomey();
            const learner = new AdaptiveParametersLearner(mockHomey);

            const params = learner.getParameters();

            // Should have default values
            expect(params.priceWeightSummer).toBe(0.7);
            expect(params.priceWeightWinter).toBe(0.4);
            expect(params.priceWeightTransition).toBe(0.5);
            expect(params.excellentCOPThreshold).toBe(0.8);
            expect(params.goodCOPThreshold).toBe(0.5);
            expect(params.minimumCOPThreshold).toBe(0.2);
            expect(params.preheatAggressiveness).toBe(2.0);
            expect(params.coastingReduction).toBe(1.5);
            expect(params.confidence).toBe(0);
            expect(params.learningCycles).toBe(0);
        });

        test('loads stored parameters from Homey settings', () => {
            const storedParams = {
                priceWeightSummer: 0.65,
                priceWeightWinter: 0.35,
                priceWeightTransition: 0.45,
                excellentCOPThreshold: 0.75,
                goodCOPThreshold: 0.45,
                minimumCOPThreshold: 0.25,
                preheatAggressiveness: 1.8,
                coastingReduction: 1.3,
                boostIncrease: 0.4,
                veryCheapMultiplier: 0.85,
                copEfficiencyBonusHigh: 0.35,
                copEfficiencyBonusMedium: 0.25,
                copAdjustmentExcellent: 0.25,
                copAdjustmentGood: 0.35,
                copAdjustmentPoor: 0.75,
                copAdjustmentVeryPoor: 1.1,
                summerModeReduction: 0.45,
                confidence: 0.5,
                lastUpdated: '2025-12-01T00:00:00Z',
                learningCycles: 50
            };

            const mockHomey = createMockHomey(storedParams);
            const learner = new AdaptiveParametersLearner(mockHomey);

            const params = learner.getParameters();

            expect(params.priceWeightSummer).toBe(0.65);
            expect(params.priceWeightWinter).toBe(0.35);
            expect(params.excellentCOPThreshold).toBe(0.75);
            expect(params.confidence).toBe(0.5);
            expect(params.learningCycles).toBe(50);
        });

        test('migrates old parameters adding new fields', () => {
            // Simulate old parameters format missing some new fields
            // Need high confidence to avoid blending with defaults
            const oldParams = {
                priceWeightSummer: 0.6,
                priceWeightWinter: 0.3,
                priceWeightTransition: 0.4,
                copEfficiencyBonusHigh: 0.3,
                copEfficiencyBonusMedium: 0.2,
                confidence: 0.5, // High enough to skip blending
                lastUpdated: '2025-01-01T00:00:00Z',
                learningCycles: 50
                // Missing: excellentCOPThreshold, goodCOPThreshold, etc.
            };

            const mockHomey = createMockHomey(oldParams as any);
            const learner = new AdaptiveParametersLearner(mockHomey);

            const params = learner.getParameters();

            // Should have old values preserved (confidence > 0.3 means no blending)
            expect(params.priceWeightSummer).toBe(0.6);
            expect(params.learningCycles).toBe(50);

            // Should have new fields with defaults
            expect(params.excellentCOPThreshold).toBeDefined();
            expect(params.preheatAggressiveness).toBeDefined();
        });
    });

    describe('learnFromOutcome', () => {
        test('increases weight by ~2% on comfort+savings success', () => {
            // Use stored params with high confidence to avoid blending
            const mockHomey = createMockHomey({
                priceWeightWinter: 0.4,
                confidence: 0.5, // High enough to skip blending
                learningCycles: 50
            } as any);
            const learner = new AdaptiveParametersLearner(mockHomey);

            const initialParams = learner.getParameters();
            const initialWeight = initialParams.priceWeightWinter;

            // Simulate successful optimization: comfort satisfied, good savings
            learner.learnFromOutcome('winter', 1.5, 0); // 0 comfort violations, positive savings

            const newParams = learner.getParameters();

            // Weight should increase by ~2%
            expect(newParams.priceWeightWinter).toBeGreaterThan(initialWeight);
            expect(newParams.priceWeightWinter).toBeCloseTo(initialWeight * 1.02, 3);
        });

        test('decreases weight by ~2% on comfort failure', () => {
            // Use stored params with high confidence to avoid blending
            const mockHomey = createMockHomey({
                priceWeightSummer: 0.7,
                confidence: 0.5, // High enough to skip blending
                learningCycles: 50
            } as any);
            const learner = new AdaptiveParametersLearner(mockHomey);

            const initialParams = learner.getParameters();
            const initialWeight = initialParams.priceWeightSummer;

            // Simulate comfort violation
            learner.learnFromOutcome('summer', 1.0, 1); // 1 comfort violation

            const newParams = learner.getParameters();

            // Weight should decrease by ~2%
            expect(newParams.priceWeightSummer).toBeLessThan(initialWeight);
            expect(newParams.priceWeightSummer).toBeCloseTo(initialWeight * 0.98, 3);
        });

        test('drifts toward the default when there is no evidence either way', () => {
            // This test previously asserted a ~1% INCREASE on no savings ("no savings: be more
            // aggressive"). Combined with the ~2% increase on success, that meant two of the three
            // branches moved the weight up and only a comfort violation moved it down — so with
            // comfort satisfied the weight could only ever rise. It did, on a live device, walking
            // to the 0.9 ceiling twice even after the inputs feeding it were corrected.
            //
            // A cycle with no saving and no comfort problem is evidence of nothing. The neutral
            // action is to drift back toward the default, not to compound aggressiveness.
            const mockHomey = createMockHomey({
                priceWeightTransition: 0.8, // above the 0.5 default
                confidence: 0.5,
                learningCycles: 50
            } as any);
            const learner = new AdaptiveParametersLearner(mockHomey);

            const initialWeight = learner.getLearnedControlParameters().priceWeightTransition;

            learner.learnFromOutcome('transition', -0.5, 0); // no savings, no violations

            const newWeight = learner.getLearnedControlParameters().priceWeightTransition;

            expect(newWeight).toBeLessThan(initialWeight);
            expect(newWeight).toBeGreaterThan(0.5); // moves toward the default, does not jump to it
        });

        test('bounds weight between 0.2 and 0.9', () => {
            const mockHomey = createMockHomey({
                priceWeightWinter: 0.89, // Near upper bound
                priceWeightSummer: 0.21, // Near lower bound
                priceWeightTransition: 0.5,
                confidence: 0,
                learningCycles: 0
            } as any);

            const learner = new AdaptiveParametersLearner(mockHomey);

            // Try to push winter weight above 0.9
            for (let i = 0; i < 10; i++) {
                learner.learnFromOutcome('winter', 2.0, 0);
            }

            let params = learner.getParameters();
            expect(params.priceWeightWinter).toBeLessThanOrEqual(0.9);

            // Try to push summer weight below 0.2
            for (let i = 0; i < 10; i++) {
                learner.learnFromOutcome('summer', 1.0, 1);
            }

            params = learner.getParameters();
            expect(params.priceWeightSummer).toBeGreaterThanOrEqual(0.2);
        });

        test('increments learningCycles', () => {
            const mockHomey = createMockHomey();
            const learner = new AdaptiveParametersLearner(mockHomey);

            expect(learner.getParameters().learningCycles).toBe(0);

            learner.learnFromOutcome('winter', 1.0, 0);
            expect(learner.getParameters().learningCycles).toBe(1);

            learner.learnFromOutcome('summer', 0.5, 0);
            expect(learner.getParameters().learningCycles).toBe(2);
        });

        test('updates lastUpdated timestamp', () => {
            const mockHomey = createMockHomey();
            const learner = new AdaptiveParametersLearner(mockHomey);

            const before = new Date().toISOString();
            learner.learnFromOutcome('winter', 1.0, 0);
            const after = new Date().toISOString();

            const params = learner.getParameters();
            expect(params.lastUpdated).toBeDefined();
            expect(new Date(params.lastUpdated).getTime()).toBeGreaterThanOrEqual(new Date(before).getTime() - 1000);
            expect(new Date(params.lastUpdated).getTime()).toBeLessThanOrEqual(new Date(after).getTime() + 1000);
        });

        test('saves to settings after learning', () => {
            const mockHomey = createMockHomey();
            const learner = new AdaptiveParametersLearner(mockHomey);

            learner.learnFromOutcome('winter', 1.0, 0);

            expect(mockHomey.settings.set).toHaveBeenCalledWith(
                'adaptive_business_parameters',
                expect.any(String)
            );
        });
    });

    describe('learnCOPThresholds', () => {
        test('lowers excellentThreshold when good outcomes at lower COP', () => {
            const mockHomey = createMockHomey({
                excellentCOPThreshold: 0.8,
                goodCOPThreshold: 0.5,
                minimumCOPThreshold: 0.2,
                confidence: 0.5,
                learningCycles: 50
            } as any);

            const learner = new AdaptiveParametersLearner(mockHomey);
            const initialThreshold = learner.getParameters().excellentCOPThreshold;

            // Simulate good outcomes with COP below excellent threshold (0.8)
            // The learnCOPThresholds method uses raw COP values, not normalized
            // COP < excellentCOPThreshold (0.8) triggers threshold lowering
            // But wait - the condition checks copPerformance < this.parameters.excellentCOPThreshold
            // where copPerformance is the raw COP passed in (e.g., 3.5)
            // This will NEVER be < 0.8, so this learning path may not trigger as expected!
            // Let me check the actual logic - ah, the COP passed in is compared against
            // the threshold directly, so a COP of 0.7 (normalized) would work.
            // But the learnFromOutcome uses raw COP values for copEfficiencyBonus learning,
            // not for threshold learning. Let me just verify it decreases over many cycles.
            for (let i = 0; i < 100; i++) {
                // Pass a COP value < excellentCOPThreshold (0.8) but still positive
                // The threshold learning uses the raw value passed in
                learner.learnFromOutcome('winter', 1.5, 0, 0.7); // 0.7 < 0.8 threshold
            }

            const newThreshold = learner.getParameters().excellentCOPThreshold;

            // Threshold should have decreased (more lenient)
            expect(newThreshold).toBeLessThan(initialThreshold);
        });

        test('raises minimumThreshold when poor outcomes at low COP', () => {
            const mockHomey = createMockHomey({
                excellentCOPThreshold: 0.8,
                goodCOPThreshold: 0.5,
                minimumCOPThreshold: 0.2,
                confidence: 0.5,
                learningCycles: 50
            } as any);

            const learner = new AdaptiveParametersLearner(mockHomey);
            const initialMinThreshold = learner.getParameters().minimumCOPThreshold;

            // Simulate poor outcomes (comfort violations) with COP below goodCOPThreshold (0.5)
            // This triggers the minimumCOPThreshold increase
            for (let i = 0; i < 100; i++) {
                learner.learnFromOutcome('winter', 0.5, 1, 0.3); // COP 0.3 < goodCOPThreshold 0.5
            }

            const newMinThreshold = learner.getParameters().minimumCOPThreshold;

            // Minimum threshold should have increased (more conservative)
            expect(newMinThreshold).toBeGreaterThan(initialMinThreshold);
        });

        test('maintains logical order: excellent > good > minimum', () => {
            const mockHomey = createMockHomey();
            const learner = new AdaptiveParametersLearner(mockHomey);

            // Many learning cycles
            for (let i = 0; i < 200; i++) {
                const season = ['summer', 'winter', 'transition'][i % 3] as any;
                const savings = Math.random() * 2;
                const violations = Math.random() > 0.8 ? 1 : 0;
                const cop = 2 + Math.random() * 3;
                learner.learnFromOutcome(season, savings, violations, cop);
            }

            const params = learner.getParameters();

            expect(params.excellentCOPThreshold).toBeGreaterThan(params.goodCOPThreshold);
            expect(params.goodCOPThreshold).toBeGreaterThan(params.minimumCOPThreshold);
        });

        test('bounds excellentThreshold above 0.3', () => {
            const mockHomey = createMockHomey({
                excellentCOPThreshold: 0.35,
                goodCOPThreshold: 0.25,
                minimumCOPThreshold: 0.15,
                confidence: 0.5,
                learningCycles: 50
            } as any);

            const learner = new AdaptiveParametersLearner(mockHomey);

            // Try to push below 0.3 with many successful low-COP outcomes
            for (let i = 0; i < 500; i++) {
                learner.learnFromOutcome('winter', 2.0, 0, 2.0);
            }

            const params = learner.getParameters();
            expect(params.excellentCOPThreshold).toBeGreaterThanOrEqual(0.3);
        });

        test('bounds minimumThreshold below 0.4', () => {
            const mockHomey = createMockHomey({
                excellentCOPThreshold: 0.8,
                goodCOPThreshold: 0.5,
                minimumCOPThreshold: 0.35,
                confidence: 0.5,
                learningCycles: 50
            } as any);

            const learner = new AdaptiveParametersLearner(mockHomey);

            // Try to push above 0.4 with many poor low-COP outcomes
            for (let i = 0; i < 500; i++) {
                learner.learnFromOutcome('winter', 0.1, 1, 1.5);
            }

            const params = learner.getParameters();
            expect(params.minimumCOPThreshold).toBeLessThanOrEqual(0.4);
        });
    });

    describe('learnStrategyAggressiveness', () => {
        test('reduces preheatAggressiveness on comfort violation', () => {
            const mockHomey = createMockHomey({
                preheatAggressiveness: 2.0,
                coastingReduction: 1.5,
                boostIncrease: 0.5,
                veryCheapMultiplier: 0.8,
                confidence: 0.5,
                learningCycles: 50
            } as any);

            const learner = new AdaptiveParametersLearner(mockHomey);
            const initial = learner.getParameters().preheatAggressiveness;

            // Comfort violations should reduce aggressiveness
            for (let i = 0; i < 50; i++) {
                learner.learnFromOutcome('winter', 1.0, 1);
            }

            const newValue = learner.getParameters().preheatAggressiveness;
            expect(newValue).toBeLessThan(initial);
        });

        test('reduces coastingReduction on comfort violation', () => {
            const mockHomey = createMockHomey({
                preheatAggressiveness: 2.0,
                coastingReduction: 1.5,
                boostIncrease: 0.5,
                veryCheapMultiplier: 0.8,
                confidence: 0.5,
                learningCycles: 50
            } as any);

            const learner = new AdaptiveParametersLearner(mockHomey);
            const initial = learner.getParameters().coastingReduction;

            for (let i = 0; i < 50; i++) {
                learner.learnFromOutcome('winter', 1.0, 1);
            }

            const newValue = learner.getParameters().coastingReduction;
            expect(newValue).toBeLessThan(initial);
        });

        test('increases veryCheapMultiplier on comfort violation (more conservative)', () => {
            const mockHomey = createMockHomey({
                veryCheapMultiplier: 0.8,
                confidence: 0.5,
                learningCycles: 50
            } as any);

            const learner = new AdaptiveParametersLearner(mockHomey);
            const initial = learner.getParameters().veryCheapMultiplier;

            for (let i = 0; i < 50; i++) {
                learner.learnFromOutcome('winter', 1.0, 1);
            }

            // Higher multiplier = more conservative (requires "cheaper" price to trigger)
            const newValue = learner.getParameters().veryCheapMultiplier;
            expect(newValue).toBeGreaterThan(initial);
        });

        test('increases aggressiveness on large savings', () => {
            const mockHomey = createMockHomey({
                preheatAggressiveness: 2.0,
                coastingReduction: 1.5,
                confidence: 0.5,
                learningCycles: 50
            } as any);

            const learner = new AdaptiveParametersLearner(mockHomey);
            const initialPreheat = learner.getParameters().preheatAggressiveness;
            const initialCoasting = learner.getParameters().coastingReduction;

            // Large savings with comfort maintained
            for (let i = 0; i < 50; i++) {
                learner.learnFromOutcome('winter', 2.0, 0); // > 0.5 savings threshold
            }

            const params = learner.getParameters();
            expect(params.preheatAggressiveness).toBeGreaterThan(initialPreheat);
            expect(params.coastingReduction).toBeGreaterThan(initialCoasting);
        });

        test('bounds preheatAggressiveness between 0.5 and 3.0', () => {
            // Test lower bound
            const mockHomeyLow = createMockHomey({
                preheatAggressiveness: 0.6,
                confidence: 0.5,
                learningCycles: 50
            } as any);

            const learnerLow = new AdaptiveParametersLearner(mockHomeyLow);

            for (let i = 0; i < 200; i++) {
                learnerLow.learnFromOutcome('winter', 1.0, 1); // Violations reduce it
            }

            expect(learnerLow.getParameters().preheatAggressiveness).toBeGreaterThanOrEqual(0.5);

            // Test upper bound
            const mockHomeyHigh = createMockHomey({
                preheatAggressiveness: 2.9,
                confidence: 0.5,
                learningCycles: 50
            } as any);

            const learnerHigh = new AdaptiveParametersLearner(mockHomeyHigh);

            for (let i = 0; i < 200; i++) {
                learnerHigh.learnFromOutcome('winter', 2.0, 0); // Good savings increase it
            }

            expect(learnerHigh.getParameters().preheatAggressiveness).toBeLessThanOrEqual(3.0);
        });
    });

    describe('getParameters with confidence blending', () => {
        test('blends with defaults at low confidence', () => {
            const mockHomey = createMockHomey({
                priceWeightWinter: 0.6, // Different from default 0.4
                confidence: 0.1, // Low confidence
                learningCycles: 10
            } as any);

            const learner = new AdaptiveParametersLearner(mockHomey);
            const params = learner.getParameters();

            // At 10% confidence, should be mostly default (0.4) with some learned (0.6)
            // Formula: default + (learned - default) * confidence = 0.4 + (0.6 - 0.4) * 0.1 = 0.42
            expect(params.priceWeightWinter).toBeCloseTo(0.42, 2);
        });

        test('returns pure learned values at high confidence', () => {
            const mockHomey = createMockHomey({
                priceWeightWinter: 0.6,
                priceWeightSummer: 0.8,
                priceWeightTransition: 0.55,
                confidence: 0.5, // High enough to skip blending (>0.3)
                learningCycles: 50
            } as any);

            const learner = new AdaptiveParametersLearner(mockHomey);
            const params = learner.getParameters();

            // Above 0.3 confidence, should return raw values
            expect(params.priceWeightWinter).toBe(0.6);
            expect(params.priceWeightSummer).toBe(0.8);
        });

        test('confidence increases to max of 1.0', () => {
            const mockHomey = createMockHomey();
            const learner = new AdaptiveParametersLearner(mockHomey);

            // Simulate 150 learning cycles (more than 100 needed for full confidence)
            for (let i = 0; i < 150; i++) {
                learner.learnFromOutcome('winter', 1.0, 0);
            }

            const params = learner.getParameters();
            expect(params.confidence).toBe(1.0);
        });
    });

    describe('long-term stability', () => {
        test('parameters stay bounded after 1000 learning cycles', () => {
            const mockHomey = createMockHomey();
            const learner = new AdaptiveParametersLearner(mockHomey);

            // Simulate 1000 random learning cycles
            for (let i = 0; i < 1000; i++) {
                const season = ['summer', 'winter', 'transition'][i % 3] as any;
                const savings = (Math.random() - 0.3) * 3; // -0.9 to 2.1
                const violations = Math.random() > 0.7 ? 1 : 0; // 30% chance
                const cop = 1.5 + Math.random() * 4; // 1.5 to 5.5
                learner.learnFromOutcome(season, savings, violations, cop);
            }

            const params = learner.getParameters();

            // All parameters should be within bounds
            expect(params.priceWeightSummer).toBeGreaterThanOrEqual(0.2);
            expect(params.priceWeightSummer).toBeLessThanOrEqual(0.9);
            expect(params.priceWeightWinter).toBeGreaterThanOrEqual(0.2);
            expect(params.priceWeightWinter).toBeLessThanOrEqual(0.9);
            expect(params.priceWeightTransition).toBeGreaterThanOrEqual(0.2);
            expect(params.priceWeightTransition).toBeLessThanOrEqual(0.9);

            expect(params.preheatAggressiveness).toBeGreaterThanOrEqual(0.5);
            expect(params.preheatAggressiveness).toBeLessThanOrEqual(3.0);
            expect(params.coastingReduction).toBeGreaterThanOrEqual(0.5);
            expect(params.coastingReduction).toBeLessThanOrEqual(2.5);

            expect(params.excellentCOPThreshold).toBeGreaterThanOrEqual(0.3);
            expect(params.minimumCOPThreshold).toBeLessThanOrEqual(0.4);

            expect(params.copEfficiencyBonusHigh).toBeGreaterThanOrEqual(0.1);
            expect(params.copEfficiencyBonusHigh).toBeLessThanOrEqual(0.5);

            expect(params.confidence).toBe(1.0);
            expect(params.learningCycles).toBe(1000);
        });

        test('parameters converge to stable values under consistent feedback', () => {
            const mockHomey = createMockHomey();
            const learner = new AdaptiveParametersLearner(mockHomey);

            // Consistent positive feedback
            for (let i = 0; i < 500; i++) {
                learner.learnFromOutcome('winter', 1.0, 0, 3.5);
            }

            const params1 = learner.getParameters();

            // 100 more cycles
            for (let i = 0; i < 100; i++) {
                learner.learnFromOutcome('winter', 1.0, 0, 3.5);
            }

            const params2 = learner.getParameters();

            // Parameters should converge (change very little after many cycles)
            // The difference between 500 and 600 cycles should be small
            expect(Math.abs(params2.priceWeightWinter - params1.priceWeightWinter)).toBeLessThan(0.05);
        });
    });

    describe('getStrategyThresholds', () => {
        test('returns all expected threshold fields', () => {
            const mockHomey = createMockHomey();
            const learner = new AdaptiveParametersLearner(mockHomey);

            const thresholds = learner.getStrategyThresholds();

            expect(thresholds).toHaveProperty('excellentCOPThreshold');
            expect(thresholds).toHaveProperty('goodCOPThreshold');
            expect(thresholds).toHaveProperty('minimumCOPThreshold');
            expect(thresholds).toHaveProperty('veryCheapMultiplier');
            expect(thresholds).toHaveProperty('preheatAggressiveness');
            expect(thresholds).toHaveProperty('coastingReduction');
            expect(thresholds).toHaveProperty('boostIncrease');
            expect(thresholds).toHaveProperty('copAdjustmentExcellent');
            expect(thresholds).toHaveProperty('copAdjustmentGood');
            expect(thresholds).toHaveProperty('copAdjustmentPoor');
            expect(thresholds).toHaveProperty('copAdjustmentVeryPoor');
            expect(thresholds).toHaveProperty('summerModeReduction');
        });

        test('thresholds reflect learned values', () => {
            const mockHomey = createMockHomey({
                excellentCOPThreshold: 0.75,
                preheatAggressiveness: 1.8,
                copAdjustmentExcellent: 0.25,
                confidence: 0.5,
                learningCycles: 50
            } as any);

            const learner = new AdaptiveParametersLearner(mockHomey);
            const thresholds = learner.getStrategyThresholds();

            expect(thresholds.excellentCOPThreshold).toBe(0.75);
            expect(thresholds.preheatAggressiveness).toBe(1.8);
            expect(thresholds.copAdjustmentExcellent).toBe(0.25);
        });
    });

    describe('COP adjustment magnitudes learning', () => {
        test('reduces adjustment magnitudes on comfort violation', () => {
            const mockHomey = createMockHomey({
                copAdjustmentGood: 0.3,
                copAdjustmentPoor: 0.8,
                copAdjustmentVeryPoor: 1.2,
                summerModeReduction: 0.5,
                confidence: 0.5,
                learningCycles: 50
            } as any);

            const learner = new AdaptiveParametersLearner(mockHomey);
            const initial = learner.getParameters();

            // Comfort violations should reduce adjustment magnitudes
            for (let i = 0; i < 50; i++) {
                learner.learnFromOutcome('winter', 1.0, 1);
            }

            const updated = learner.getParameters();

            expect(updated.copAdjustmentGood).toBeLessThan(initial.copAdjustmentGood);
            expect(updated.copAdjustmentPoor).toBeLessThan(initial.copAdjustmentPoor);
            expect(updated.copAdjustmentVeryPoor).toBeLessThan(initial.copAdjustmentVeryPoor);
            expect(updated.summerModeReduction).toBeLessThan(initial.summerModeReduction);
        });

        test('increases adjustment magnitudes on good savings', () => {
            const mockHomey = createMockHomey({
                copAdjustmentGood: 0.3,
                copAdjustmentPoor: 0.8,
                copAdjustmentVeryPoor: 1.2,
                confidence: 0.5,
                learningCycles: 50
            } as any);

            const learner = new AdaptiveParametersLearner(mockHomey);
            const initial = learner.getParameters();

            // Good savings with comfort should increase adjustment magnitudes
            for (let i = 0; i < 50; i++) {
                learner.learnFromOutcome('winter', 2.0, 0); // > 0.5 savings
            }

            const updated = learner.getParameters();

            expect(updated.copAdjustmentGood).toBeGreaterThan(initial.copAdjustmentGood);
            expect(updated.copAdjustmentPoor).toBeGreaterThan(initial.copAdjustmentPoor);
            expect(updated.copAdjustmentVeryPoor).toBeGreaterThan(initial.copAdjustmentVeryPoor);
        });

        test('copAdjustmentGood stays within bounds [0.1, 0.5]', () => {
            // Test lower bound
            const mockHomeyLow = createMockHomey({
                copAdjustmentGood: 0.15,
                confidence: 0.5,
                learningCycles: 50
            } as any);

            const learnerLow = new AdaptiveParametersLearner(mockHomeyLow);

            for (let i = 0; i < 200; i++) {
                learnerLow.learnFromOutcome('winter', 1.0, 1);
            }

            expect(learnerLow.getParameters().copAdjustmentGood).toBeGreaterThanOrEqual(0.1);

            // Test upper bound
            const mockHomeyHigh = createMockHomey({
                copAdjustmentGood: 0.45,
                confidence: 0.5,
                learningCycles: 50
            } as any);

            const learnerHigh = new AdaptiveParametersLearner(mockHomeyHigh);

            for (let i = 0; i < 200; i++) {
                learnerHigh.learnFromOutcome('winter', 2.0, 0);
            }

            expect(learnerHigh.getParameters().copAdjustmentGood).toBeLessThanOrEqual(0.5);
        });
    });

    describe('error handling', () => {
        test('handles settings.get error gracefully', () => {
            const mockHomey = {
                settings: {
                    get: jest.fn(() => { throw new Error('Settings error'); }),
                    set: jest.fn()
                },
                log: jest.fn(),
                error: jest.fn()
            };

            // Should not throw, should use defaults
            const learner = new AdaptiveParametersLearner(mockHomey);
            const params = learner.getParameters();

            expect(params.priceWeightSummer).toBe(0.7); // Default value
            expect(mockHomey.error).toHaveBeenCalled();
        });

        test('handles settings.set error gracefully', () => {
            const mockHomey = {
                settings: {
                    get: jest.fn(() => null),
                    set: jest.fn(() => { throw new Error('Save error'); })
                },
                log: jest.fn(),
                error: jest.fn()
            };

            const learner = new AdaptiveParametersLearner(mockHomey);

            // Should not throw
            expect(() => {
                learner.learnFromOutcome('winter', 1.0, 0);
            }).not.toThrow();

            expect(mockHomey.error).toHaveBeenCalled();
        });

        test('handles invalid stored JSON gracefully', () => {
            const mockHomey = {
                settings: {
                    get: jest.fn(() => 'not valid json'),
                    set: jest.fn()
                },
                log: jest.fn(),
                error: jest.fn()
            };

            const learner = new AdaptiveParametersLearner(mockHomey);
            const params = learner.getParameters();

            expect(params.priceWeightSummer).toBe(0.7); // Default value
            expect(mockHomey.error).toHaveBeenCalled();
        });
    });

    describe('learnEnvironmentalResponse', () => {
        test('increases coldOutdoorBonus when cold and comfort violated', () => {
            const mockHomey = createMockHomey({
                coldOutdoorBonus: 0.5,
                confidence: 0.5,
                learningCycles: 50
            } as any);

            const learner = new AdaptiveParametersLearner(mockHomey);
            const initialBonus = learner.getParameters().coldOutdoorBonus;

            // Cold weather (< 5°C), comfort NOT satisfied
            learner.learnEnvironmentalResponse(2, false, false);

            expect(learner.getParameters().coldOutdoorBonus).toBeGreaterThan(initialBonus);
        });

        test('decreases coldOutdoorBonus when cold but comfortable with savings', () => {
            const mockHomey = createMockHomey({
                coldOutdoorBonus: 0.5,
                confidence: 0.5,
                learningCycles: 50
            } as any);

            const learner = new AdaptiveParametersLearner(mockHomey);
            const initialBonus = learner.getParameters().coldOutdoorBonus;

            // Cold weather, comfort satisfied with good savings
            learner.learnEnvironmentalResponse(2, true, true);

            expect(learner.getParameters().coldOutdoorBonus).toBeLessThan(initialBonus);
        });

        test('decreases mildOutdoorReduction when mild and comfort violated', () => {
            const mockHomey = createMockHomey({
                mildOutdoorReduction: 0.3,
                confidence: 0.5,
                learningCycles: 50
            } as any);

            const learner = new AdaptiveParametersLearner(mockHomey);
            const initialReduction = learner.getParameters().mildOutdoorReduction;

            // Mild weather (> 15°C), comfort NOT satisfied (too warm)
            learner.learnEnvironmentalResponse(18, false, false);

            expect(learner.getParameters().mildOutdoorReduction).toBeLessThan(initialReduction);
        });

        test('increases mildOutdoorReduction when mild and comfortable with savings', () => {
            const mockHomey = createMockHomey({
                mildOutdoorReduction: 0.3,
                confidence: 0.5,
                learningCycles: 50
            } as any);

            const learner = new AdaptiveParametersLearner(mockHomey);
            const initialReduction = learner.getParameters().mildOutdoorReduction;

            // Mild weather, comfort satisfied with good savings
            learner.learnEnvironmentalResponse(18, true, true);

            expect(learner.getParameters().mildOutdoorReduction).toBeGreaterThan(initialReduction);
        });

        test('adjusts transitionEfficiencyReduction in transition range', () => {
            const mockHomey = createMockHomey({
                transitionEfficiencyReduction: 0.4,
                confidence: 0.5,
                learningCycles: 50
            } as any);

            const learner = new AdaptiveParametersLearner(mockHomey);
            const initialReduction = learner.getParameters().transitionEfficiencyReduction;

            // Transition weather (5-15°C), comfort violated
            learner.learnEnvironmentalResponse(10, false, false);

            expect(learner.getParameters().transitionEfficiencyReduction).toBeLessThan(initialReduction);
        });

        test('coldOutdoorBonus stays within bounds [0.2, 1.0]', () => {
            // Test lower bound
            const mockHomeyLow = createMockHomey({
                coldOutdoorBonus: 0.25,
                confidence: 0.5,
                learningCycles: 50
            } as any);

            const learnerLow = new AdaptiveParametersLearner(mockHomeyLow);

            for (let i = 0; i < 100; i++) {
                learnerLow.learnEnvironmentalResponse(2, true, true); // Decrease
            }

            expect(learnerLow.getParameters().coldOutdoorBonus).toBeGreaterThanOrEqual(0.2);

            // Test upper bound
            const mockHomeyHigh = createMockHomey({
                coldOutdoorBonus: 0.9,
                confidence: 0.5,
                learningCycles: 50
            } as any);

            const learnerHigh = new AdaptiveParametersLearner(mockHomeyHigh);

            for (let i = 0; i < 100; i++) {
                learnerHigh.learnEnvironmentalResponse(2, false, false); // Increase
            }

            expect(learnerHigh.getParameters().coldOutdoorBonus).toBeLessThanOrEqual(1.0);
        });

        test('mildOutdoorReduction stays within bounds [0.1, 0.6]', () => {
            // Test lower bound
            const mockHomeyLow = createMockHomey({
                mildOutdoorReduction: 0.15,
                confidence: 0.5,
                learningCycles: 50
            } as any);

            const learnerLow = new AdaptiveParametersLearner(mockHomeyLow);

            for (let i = 0; i < 100; i++) {
                learnerLow.learnEnvironmentalResponse(18, false, false); // Decrease
            }

            expect(learnerLow.getParameters().mildOutdoorReduction).toBeGreaterThanOrEqual(0.1);

            // Test upper bound
            const mockHomeyHigh = createMockHomey({
                mildOutdoorReduction: 0.55,
                confidence: 0.5,
                learningCycles: 50
            } as any);

            const learnerHigh = new AdaptiveParametersLearner(mockHomeyHigh);

            for (let i = 0; i < 100; i++) {
                learnerHigh.learnEnvironmentalResponse(18, true, true); // Increase
            }

            expect(learnerHigh.getParameters().mildOutdoorReduction).toBeLessThanOrEqual(0.6);
        });

        test('does not modify parameters when outdoor temp is in neutral range without savings', () => {
            const mockHomey = createMockHomey({
                coldOutdoorBonus: 0.5,
                mildOutdoorReduction: 0.3,
                confidence: 0.5,
                learningCycles: 50
            } as any);

            const learner = new AdaptiveParametersLearner(mockHomey);
            const initialColdBonus = learner.getParameters().coldOutdoorBonus;
            const initialMildReduction = learner.getParameters().mildOutdoorReduction;

            // Neutral temperature (5-15°C range), no savings (so only transition param could change)
            learner.learnEnvironmentalResponse(10, true, false);

            // Cold and mild params should be unchanged (temp not in their ranges)
            expect(learner.getParameters().coldOutdoorBonus).toBe(initialColdBonus);
            expect(learner.getParameters().mildOutdoorReduction).toBe(initialMildReduction);
        });
    });

    describe('learnTimingParameters', () => {
        test('decreases maxCoastingHoursMultiplier when coasting causes discomfort', () => {
            const mockHomey = createMockHomey({
                maxCoastingHoursMultiplier: 1.0,
                confidence: 0.5,
                learningCycles: 50
            } as any);

            const learner = new AdaptiveParametersLearner(mockHomey);
            const initialMultiplier = learner.getParameters().maxCoastingHoursMultiplier;

            // Coasted for 3 hours, comfort violated
            learner.learnTimingParameters(3, 4, 'coast', false);

            expect(learner.getParameters().maxCoastingHoursMultiplier).toBeLessThan(initialMultiplier);
        });

        test('increases maxCoastingHoursMultiplier when could coast longer comfortably', () => {
            const mockHomey = createMockHomey({
                maxCoastingHoursMultiplier: 1.0,
                confidence: 0.5,
                learningCycles: 50
            } as any);

            const learner = new AdaptiveParametersLearner(mockHomey);
            const initialMultiplier = learner.getParameters().maxCoastingHoursMultiplier;

            // Coasted for 2 hours but expected 4, comfort was fine
            learner.learnTimingParameters(2, 4, 'coast', true);

            expect(learner.getParameters().maxCoastingHoursMultiplier).toBeGreaterThan(initialMultiplier);
        });

        test('increases preheatDurationMultiplier when preheat fails to achieve comfort', () => {
            const mockHomey = createMockHomey({
                preheatDurationMultiplier: 1.0,
                confidence: 0.5,
                learningCycles: 50
            } as any);

            const learner = new AdaptiveParametersLearner(mockHomey);
            const initialMultiplier = learner.getParameters().preheatDurationMultiplier;

            // Preheat didn't achieve comfort
            learner.learnTimingParameters(2, 2, 'preheat', false);

            expect(learner.getParameters().preheatDurationMultiplier).toBeGreaterThan(initialMultiplier);
        });

        test('decreases preheatDurationMultiplier when preheat took longer than needed', () => {
            const mockHomey = createMockHomey({
                preheatDurationMultiplier: 1.0,
                confidence: 0.5,
                learningCycles: 50
            } as any);

            const learner = new AdaptiveParametersLearner(mockHomey);
            const initialMultiplier = learner.getParameters().preheatDurationMultiplier;

            // Preheated for 3 hours but only needed 2 (> 1.2x expected)
            learner.learnTimingParameters(3, 2, 'preheat', true);

            expect(learner.getParameters().preheatDurationMultiplier).toBeLessThan(initialMultiplier);
        });

        test('maxCoastingHoursMultiplier stays within bounds [0.5, 1.5]', () => {
            // Test lower bound
            const mockHomeyLow = createMockHomey({
                maxCoastingHoursMultiplier: 0.6,
                confidence: 0.5,
                learningCycles: 50
            } as any);

            const learnerLow = new AdaptiveParametersLearner(mockHomeyLow);

            for (let i = 0; i < 50; i++) {
                learnerLow.learnTimingParameters(3, 4, 'coast', false); // Decrease
            }

            expect(learnerLow.getParameters().maxCoastingHoursMultiplier).toBeGreaterThanOrEqual(0.5);

            // Test upper bound
            const mockHomeyHigh = createMockHomey({
                maxCoastingHoursMultiplier: 1.4,
                confidence: 0.5,
                learningCycles: 50
            } as any);

            const learnerHigh = new AdaptiveParametersLearner(mockHomeyHigh);

            for (let i = 0; i < 50; i++) {
                learnerHigh.learnTimingParameters(2, 4, 'coast', true); // Increase
            }

            expect(learnerHigh.getParameters().maxCoastingHoursMultiplier).toBeLessThanOrEqual(1.5);
        });

        test('preheatDurationMultiplier stays within bounds [0.6, 1.5]', () => {
            // Test lower bound
            const mockHomeyLow = createMockHomey({
                preheatDurationMultiplier: 0.7,
                confidence: 0.5,
                learningCycles: 50
            } as any);

            const learnerLow = new AdaptiveParametersLearner(mockHomeyLow);

            for (let i = 0; i < 50; i++) {
                learnerLow.learnTimingParameters(3, 2, 'preheat', true); // Decrease
            }

            expect(learnerLow.getParameters().preheatDurationMultiplier).toBeGreaterThanOrEqual(0.6);

            // Test upper bound
            const mockHomeyHigh = createMockHomey({
                preheatDurationMultiplier: 1.4,
                confidence: 0.5,
                learningCycles: 50
            } as any);

            const learnerHigh = new AdaptiveParametersLearner(mockHomeyHigh);

            for (let i = 0; i < 50; i++) {
                learnerHigh.learnTimingParameters(2, 2, 'preheat', false); // Increase
            }

            expect(learnerHigh.getParameters().preheatDurationMultiplier).toBeLessThanOrEqual(1.5);
        });

        test('does not decrease coasting multiplier for short durations even with discomfort', () => {
            const mockHomey = createMockHomey({
                maxCoastingHoursMultiplier: 1.0,
                confidence: 0.5,
                learningCycles: 50
            } as any);

            const learner = new AdaptiveParametersLearner(mockHomey);
            const initialMultiplier = learner.getParameters().maxCoastingHoursMultiplier;

            // Coasted for only 1.5 hours with discomfort (< 2h threshold)
            learner.learnTimingParameters(1.5, 4, 'coast', false);

            // Should not decrease because actualDuration < 2
            expect(learner.getParameters().maxCoastingHoursMultiplier).toBe(initialMultiplier);
        });
    });

    describe('new parameters in getStrategyThresholds', () => {
        test('returns all new environmental and timing parameters', () => {
            const mockHomey = createMockHomey({
                coldOutdoorBonus: 0.6,
                mildOutdoorReduction: 0.4,
                transitionEfficiencyReduction: 0.5,
                maxCoastingHoursMultiplier: 1.2,
                preheatDurationMultiplier: 0.9,
                confidence: 0.5,
                learningCycles: 50
            } as any);

            const learner = new AdaptiveParametersLearner(mockHomey);
            const thresholds = learner.getStrategyThresholds();

            expect(thresholds.coldOutdoorBonus).toBe(0.6);
            expect(thresholds.mildOutdoorReduction).toBe(0.4);
            expect(thresholds.transitionEfficiencyReduction).toBe(0.5);
            expect(thresholds.maxCoastingHoursMultiplier).toBe(1.2);
            expect(thresholds.preheatDurationMultiplier).toBe(0.9);
        });

        test('uses defaults for new parameters when not stored', () => {
            const mockHomey = createMockHomey(); // Empty storage

            const learner = new AdaptiveParametersLearner(mockHomey);
            const thresholds = learner.getStrategyThresholds();

            // Should return default values
            expect(thresholds.coldOutdoorBonus).toBe(0.5);
            expect(thresholds.mildOutdoorReduction).toBe(0.3);
            expect(thresholds.transitionEfficiencyReduction).toBe(0.4);
            expect(thresholds.maxCoastingHoursMultiplier).toBe(1.0);
            expect(thresholds.preheatDurationMultiplier).toBe(1.0);
        });
    });
});

describe('price weight cannot ratchet in one direction', () => {
  function makeLearner() {
    const store: Record<string, any> = {};
    const homey: any = {
      settings: {
        get: (k: string) => store[k],
        set: (k: string, v: any) => { store[k] = v; }
      },
      log: jest.fn(),
      error: jest.fn()
    };
    return new AdaptiveParametersLearner(homey);
  }

  // Regression: two of the three branches used to multiply the weight upward, so with comfort
  // satisfied it could only ever rise. Measured live walking 0.7 -> the 0.9 ceiling twice.
  test('repeated cycles with no savings do not drive the weight to the ceiling', () => {
    const learner = makeLearner();

    for (let i = 0; i < 200; i++) {
      learner.learnFromOutcome('summer', 0, 0);
    }

    const weight = learner.getLearnedControlParameters().priceWeightSummer;
    expect(weight).toBeLessThan(0.9);
    expect(weight).toBeCloseTo(0.7, 1);
  });

  test('no-evidence cycles pull a drifted weight back toward the default', () => {
    const learner = makeLearner();

    // Push it up with genuine savings first.
    for (let i = 0; i < 40; i++) learner.learnFromOutcome('summer', 1.0, 0);
    const raised = learner.getLearnedControlParameters().priceWeightSummer;
    expect(raised).toBeGreaterThan(0.7);

    // Then a long run of nothing happening.
    for (let i = 0; i < 100; i++) learner.learnFromOutcome('summer', 0, 0);
    const settled = learner.getLearnedControlParameters().priceWeightSummer;

    expect(settled).toBeLessThan(raised);
    expect(settled).toBeCloseTo(0.7, 1);
  });

  test('genuine savings still raise the weight', () => {
    const learner = makeLearner();

    for (let i = 0; i < 10; i++) learner.learnFromOutcome('summer', 1.0, 0);

    expect(learner.getLearnedControlParameters().priceWeightSummer).toBeGreaterThan(0.7);
  });

  test('comfort violations still lower the weight', () => {
    const learner = makeLearner();

    for (let i = 0; i < 10; i++) learner.learnFromOutcome('summer', 1.0, 3);

    expect(learner.getLearnedControlParameters().priceWeightSummer).toBeLessThan(0.7);
  });
});
