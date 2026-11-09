//! Fold a separate texture + sampler into one combined sampled-image binding.
//!
//! # Why this exists
//!
//! `SDL_GPU`'s Vulkan backend builds a **fixed** descriptor set layout and
//! requires the shader to match it. For a fragment stage, set 2 binding `i` is
//! declared `VK_DESCRIPTOR_TYPE_COMBINED_IMAGE_SAMPLER`, one binding per sampler
//! slot (`SDL_gpu_vulkan.c`, `VULKAN_INTERNAL_FetchDescriptorSetLayout`). One
//! binding, one slot, both halves of the sampler.
//!
//! Naga cannot express that. Its GLSL frontend refuses an opaque uniform
//! outright — `NotImplemented("variable qualifier")` on `sampler2D`,
//! `sampler2DArray`, and every other spelling — because its IR models images and
//! samplers as separate values, following WGSL. So the GLSL generator has to
//! declare the pair separately:
//!
//! ```glsl
//! layout(set = 2, binding = 0) uniform texture2DArray u_tex;
//! layout(set = 2, binding = 1) uniform sampler u_sampler;
//! ```
//!
//! which compiles to two variables where SDL's layout has one, and the driver
//! refuses the pipeline. Measured on Mesa `dzn`: the validation layer names the
//! cause exactly —
//!
//! ```text
//! VUID-VkGraphicsPipelineCreateInfo-layout-07988: pCreateInfos[0].pStages[1]
//! SPIR-V uses descriptor [Set 2, Binding 1] but the binding was not declared
//! in VkPipelineLayoutCreateInfo::pSetLayouts[2].
//! ```
//!
//! — and `dzn` reports it as `VK_ERROR_OUT_OF_HOST_MEMORY`, which reads like an
//! allocation failure and is not one.
//!
//! # What it does
//!
//! After naga has emitted a module, rewrite the pair into the one shape SDL
//! declares:
//!
//! ```text
//! before                                  after
//! %6  = OpTypeImage ...                   %6  = OpTypeImage ...
//! %7  = OpTypeSampler                     %7  = OpTypeSampler
//! %43 = OpVariable ptr-to-%6  (binding 0) %S  = OpTypeSampledImage %6
//! %45 = OpVariable ptr-to-%7  (binding 1) %P  = OpTypePointer UniformConstant %S
//! %53 = OpLoad %6 %43                     %43 = OpVariable %P      (binding 0)
//! %54 = OpLoad %7 %45                     %53 = OpLoad %S %43
//! %74 = OpSampledImage %71 %53 %54        (the OpSampledImage and its uses
//! %x  = OpImageSample... %74                    now take %53 directly)
//! ```
//!
//! The combined variable keeps the **texture's** binding, which is the slot
//! SDL numbers. The sampler variable, its `OpLoad`, and the `OpSampledImage`
//! are removed.
//!
//! # Why this is a rewrite and not an IR transform
//!
//! Naga's IR has no combined-sampler type to build: `OpTypeSampledImage` is
//! synthesised by the writer at each sample site, and the writer emits one
//! `OpVariable` per global handle. There is no IR shape that would make it emit
//! what SDL wants, which is why the change is made to the words naga produced.
//!
//! # The safety rules
//!
//! - **Exactly one pair, or a refusal.** A module with two sampler pairs, or
//!   with a sampler that has no adjacent texture, returns an error rather than
//!   guessing. A half-rewritten module would be worse than an unrewritten one.
//! - **Uses are checked before anything is deleted.** The texture variable may
//!   be read by an `OpLoad` and by decorations; the sampler likewise; the loaded
//!   values may be used only as `OpSampledImage`'s two operands. Anything else
//!   is a shape this transform does not understand, and it says so.
//! - **The post-condition is the absence of the deleted ids.** The operand
//!   table below knows which operands of which opcode are ids, so replacement is
//!   exact; and after the rewrite every deleted id is searched for across the
//!   whole module. Finding one means the analysis missed a use.

/// Words before the first instruction: magic, version, generator, bound, schema.
const HEADER_WORDS: usize = 5;
/// Where the id bound lives in the header.
const BOUND_WORD: usize = 3;

const OP_NAME: u16 = 5;
const OP_EXTENSION: u16 = 10;
const OP_EXT_INST_IMPORT: u16 = 11;
const OP_MEMORY_MODEL: u16 = 14;
const OP_ENTRY_POINT: u16 = 15;
const OP_EXECUTION_MODE: u16 = 16;
const OP_EXT_INST: u16 = 12;
const OP_CAPABILITY: u16 = 17;
const OP_TYPE_IMAGE: u16 = 25;
const OP_TYPE_SAMPLER: u16 = 26;
const OP_TYPE_SAMPLED_IMAGE: u16 = 27;
const OP_TYPE_POINTER: u16 = 32;
const OP_CONSTANT: u16 = 43;
const OP_CONSTANT_NULL: u16 = 46;
const OP_FUNCTION: u16 = 54;
const OP_FUNCTION_END: u16 = 56;
const OP_FUNCTION_CALL: u16 = 57;
const OP_VARIABLE: u16 = 59;
const OP_LOAD: u16 = 61;
const OP_STORE: u16 = 62;
const OP_ACCESS_CHAIN: u16 = 65;
const OP_DECORATE: u16 = 71;
const OP_MEMBER_DECORATE: u16 = 72;
const OP_VECTOR_SHUFFLE: u16 = 79;
const OP_COMPOSITE_CONSTRUCT: u16 = 80;
const OP_COMPOSITE_EXTRACT: u16 = 81;
const OP_SAMPLED_IMAGE: u16 = 86;
const OP_IMAGE_SAMPLE_IMPLICIT_LOD: u16 = 87;
const OP_LABEL: u16 = 248;
const OP_BRANCH: u16 = 249;
const OP_RETURN: u16 = 253;

const DECORATE_BINDING: u32 = 33;
const DECORATE_DESCRIPTOR_SET: u32 = 34;
const STORAGE_UNIFORM_CONSTANT: u32 = 0;

/// One instruction's extent in the module.
#[derive(Clone, Copy, Debug)]
struct Insn {
    /// Index of the opcode word.
    at: usize,
    op: u16,
    wc: usize,
}

impl Insn {
    fn operands<'a>(&self, words: &'a [u32]) -> &'a [u32] {
        &words[self.at + 1..self.at + self.wc]
    }
}

/// Split a module into instructions, or say which one is malformed.
fn instructions(words: &[u32]) -> std::result::Result<Vec<Insn>, String> {
    let mut out = Vec::new();
    let mut at = HEADER_WORDS;
    while at < words.len() {
        if at + 1 > words.len() {
            return Err(format!("truncated instruction header at word {at}"));
        }
        let head = words[at];
        let op = (head & 0xffff) as u16;
        let wc = (head >> 16) as usize;
        if wc == 0 || at + wc > words.len() {
            return Err(format!(
                "malformed instruction at word {at}: opcode {op}, word count {wc}"
            ));
        }
        out.push(Insn { at, op, wc });
        at += wc;
    }
    Ok(out)
}

/// Which operands of `op` are ids.
///
/// `Some((positions, tail_is_ids))`: the listed positions are ids, and if
/// `tail_is_ids` every operand after the last listed position is an id too.
/// `None` means this transform does not know the instruction well enough to
/// rewrite ids safely — and a module that needs rewriting while containing one
/// is refused rather than guessed at.
///
/// The set is exactly what these generated shaders contain plus the handful of
/// neighbouring opcodes a preset could plausibly add. A missing entry is a
/// refusal, never a silent miss.
fn id_operands(op: u16) -> Option<(&'static [usize], bool)> {
    Some(match op {
        OP_EXTENSION | OP_MEMORY_MODEL => (&[], false),
        OP_EXT_INST_IMPORT => (&[0], false),
        OP_ENTRY_POINT | OP_EXECUTION_MODE => (&[0], false),
        OP_CAPABILITY => (&[], false),
        OP_NAME => (&[0], false),
        OP_FUNCTION_END => (&[], false),
        // Every `OpType*` has its result id first; the type instructions these
        // shaders contain never name a variable.
        19..=39 => (&[0], false),
        OP_CONSTANT | OP_CONSTANT_NULL => (&[0, 1], false),
        OP_DECORATE => (&[0], false),
        OP_MEMBER_DECORATE => (&[0], false),
        // OpExtInst %type %result %set LiteralInstruction operands...
        OP_EXT_INST => (&[0, 1, 2], true), // special-cased in `ids_of`
        OP_TYPE_IMAGE | OP_TYPE_SAMPLER | OP_TYPE_SAMPLED_IMAGE => (&[0], false),
        // OpTypePointer %result %storageClass %pointee
        OP_TYPE_POINTER => (&[0, 2], false),
        // OpFunction %type %result %control %functionType
        OP_FUNCTION => (&[0, 1, 3], false),
        OP_FUNCTION_CALL => (&[0, 1, 2], true),
        // OpVariable %ptrType %result %storageClass [initializer]
        OP_VARIABLE => (&[0, 1, 3], false),
        OP_LOAD => (&[0, 1, 2], false),
        OP_STORE => (&[0, 1], false),
        OP_ACCESS_CHAIN => (&[0, 1, 2], true),
        OP_VECTOR_SHUFFLE => (&[0, 1, 2, 3], false),
        OP_COMPOSITE_CONSTRUCT => (&[0, 1], true),
        OP_COMPOSITE_EXTRACT => (&[0, 1, 2], false),
        OP_SAMPLED_IMAGE => (&[0, 1, 2, 3], false),
        OP_IMAGE_SAMPLE_IMPLICIT_LOD => (&[0, 1, 2, 3], true),
        // The conversion family: %type %result %operand [memory operands].
        109..=123 => (&[0, 1, 2], false),
        // OpBitcast takes memory operands after its value.
        124 => (&[0, 1, 2], true),
        OP_LABEL => (&[0], false),
        OP_BRANCH => (&[0], false),
        OP_RETURN => (&[], false),
        _ => return None,
    })
}

/// The id operands of one instruction, in order.
fn ids_of(insn: &Insn, words: &[u32]) -> std::result::Result<Vec<u32>, String> {
    let (positions, tail) = id_operands(insn.op)
        .ok_or_else(|| format!("opcode {} is not one this transform understands", insn.op))?;
    let operands = insn.operands(words);
    let mut out = Vec::new();
    if insn.op == OP_EXT_INST {
        // `%type %result %set LiteralInstruction operands...` — operand 3 is a
        // literal, so the id tail starts at 4. The generic rule would treat it
        // as an id and could mistake an extended-instruction number for one.
        out.extend(operands.iter().take(3));
        out.extend(operands.iter().skip(4));
        return Ok(out);
    }
    for &at in positions {
        if at < operands.len() {
            out.push(operands[at]);
        }
    }
    if tail {
        let from = positions.last().copied().unwrap_or(0) + 1;
        for value in operands.iter().skip(from) {
            out.push(*value);
        }
    }
    Ok(out)
}

/// The module's `OpTypeSampledImage` declarations for `image_type`.
///
/// Naga declares one wherever it samples, and emits it *after* the globals it
/// is used from — lazily, not in a type section. The fold needs the type before
/// the variable, so it declares its own and removes these: once the
/// `OpSampledImage` instructions are gone, nothing else refers to them.
fn stale_sampled_images(insns: &[Insn], words: &[u32], image_type: u32) -> Vec<usize> {
    insns
        .iter()
        .enumerate()
        .filter_map(|(index, insn)| {
            if insn.op != OP_TYPE_SAMPLED_IMAGE {
                return None;
            }
            let ops = insn.operands(words);
            (ops.len() >= 2 && ops[1] == image_type).then_some(index)
        })
        .collect()
}

/// A uniform-constant variable, with what it points at.
#[derive(Clone, Copy, Debug)]
struct SamplerVar {
    var_id: u32,
    pointee_type: u32,
    pointee_op: u16,
    set: u32,
    binding: u32,
    decl: usize,
}

/// Fold the module's texture/sampler pair into one combined binding.
///
/// Returns `Ok(false)` when there is no pair (a vertex stage, or a preset whose
/// shader samples nothing) and `Ok(true)` when a rewrite happened.
pub fn fold_combined_samplers(words: &mut Vec<u32>) -> std::result::Result<bool, String> {
    let insns = instructions(words)?;

    // ── find the uniform-constant variables, and what each points at ──────
    let mut pointers: std::collections::HashMap<u32, u32> = std::collections::HashMap::new();
    let mut type_ops: std::collections::HashMap<u32, u16> = std::collections::HashMap::new();
    let mut decorations: std::collections::HashMap<u32, (Option<u32>, Option<u32>)> =
        std::collections::HashMap::new();
    for insn in &insns {
        let ops = insn.operands(words);
        match insn.op {
            OP_TYPE_POINTER if ops.len() >= 3 => {
                pointers.insert(ops[0], ops[2]);
                type_ops.insert(ops[0], insn.op);
            }
            // Every other `OpType*` has its result id first.
            19..=39 if insn.op != OP_TYPE_POINTER && !ops.is_empty() => {
                type_ops.insert(ops[0], insn.op);
            }
            OP_DECORATE if ops.len() >= 2 && ops[0] != 0 => {
                let entry = decorations.entry(ops[0]).or_insert((None, None));
                if ops[1] == DECORATE_DESCRIPTOR_SET && ops.len() >= 3 {
                    entry.0 = Some(ops[2]);
                }
                if ops[1] == DECORATE_BINDING && ops.len() >= 3 {
                    entry.1 = Some(ops[2]);
                }
            }
            _ => {}
        }
    }

    let mut vars: Vec<SamplerVar> = Vec::new();
    for (index, insn) in insns.iter().enumerate() {
        if insn.op != OP_VARIABLE {
            continue;
        }
        let ops = insn.operands(words);
        if ops.len() < 3 || ops[2] != STORAGE_UNIFORM_CONSTANT {
            continue;
        }
        let Some(&pointee) = pointers.get(&ops[0]) else {
            continue;
        };
        let Some(&pointee_op) = type_ops.get(&pointee) else {
            continue;
        };
        if pointee_op != OP_TYPE_IMAGE && pointee_op != OP_TYPE_SAMPLER {
            continue;
        }
        let (set, binding) = decorations.get(&ops[1]).copied().unwrap_or((None, None));
        vars.push(SamplerVar {
            var_id: ops[1],
            pointee_type: pointee,
            pointee_op,
            set: set.unwrap_or(u32::MAX),
            binding: binding.unwrap_or(u32::MAX),
            decl: index,
        });
    }

    let textures: Vec<SamplerVar> = vars
        .iter()
        .copied()
        .filter(|v| v.pointee_op == OP_TYPE_IMAGE)
        .collect();
    let samplers: Vec<SamplerVar> = vars
        .iter()
        .copied()
        .filter(|v| v.pointee_op == OP_TYPE_SAMPLER)
        .collect();
    if textures.is_empty() && samplers.is_empty() {
        return Ok(false);
    }
    if textures.len() != 1 || samplers.len() != 1 {
        return Err(format!(
            "expected one texture/sampler pair, found {} texture(s) and {} sampler(s); \
             this transform only knows the shape the 2D generator emits",
            textures.len(),
            samplers.len()
        ));
    }
    let texture = textures[0];
    let sampler = samplers[0];
    if texture.set != sampler.set || sampler.binding != texture.binding + 1 {
        return Err(format!(
            "texture is set {} binding {} and sampler is set {} binding {}; expected the \
             sampler one binding above the texture in the same set",
            texture.set, texture.binding, sampler.set, sampler.binding
        ));
    }

    // ── classify the uses that move ───────────────────────────────────────
    //
    // Naga emits one `OpLoad` per *expression*, so the same variable can be
    // loaded more than once — the default graph loads the texture twice, once
    // for the sample and once into a dead local. The transform therefore
    // handles any number of loads and any number of sample sites, and only
    // insists that each loaded value is read by nothing but `OpSampledImage`.
    let mut texture_loads: Vec<(usize, u32)> = Vec::new();
    let mut sampler_loads: Vec<(usize, u32)> = Vec::new();
    let mut sample_sites: Vec<(usize, u32, u32, u32)> = Vec::new(); // (insn, result, image, sampler)
    for (index, insn) in insns.iter().enumerate() {
        let ops = insn.operands(words);
        match insn.op {
            OP_DECORATE | OP_NAME | OP_VARIABLE if !ops.is_empty() => continue,
            OP_LOAD if ops.len() >= 3 => {
                if ops[2] == texture.var_id {
                    texture_loads.push((index, ops[1]));
                } else if ops[2] == sampler.var_id {
                    sampler_loads.push((index, ops[1]));
                }
                continue;
            }
            OP_SAMPLED_IMAGE if ops.len() >= 4 => {
                sample_sites.push((index, ops[1], ops[2], ops[3]));
                continue;
            }
            _ => {}
        }
        // Any other mention of a variable is a use this transform does not
        // model. Only *id* operands count: a literal that happens to equal an id
        // is not a use, and `OpCapability Sampled1D` is the literal 43 while
        // naga's 43rd id is the texture variable.
        for value in ids_of(insn, words)? {
            if value == texture.var_id || value == sampler.var_id {
                return Err(format!(
                    "variable {value} is used by an instruction this transform does not \
                     model (opcode {})",
                    insn.op
                ));
            }
        }
    }

    if texture_loads.is_empty() {
        // The pair exists but nothing reads the texture — a preset that declares
        // the sampler and draws without it. Fold anyway so the binding matches,
        // by dropping the sampler and re-typing the texture.
        return fold_unused_texture(words, &insns, texture, sampler);
    }

    // Every sample site must combine one of *our* texture loads with one of
    // *our* sampler loads.
    for (index, _, image, sampler_value) in &sample_sites {
        if !texture_loads.iter().any(|(_, id)| id == image) {
            return Err(format!(
                "the OpSampledImage at {} uses image {}, which is not a load of the \
                 texture variable",
                insns[*index].at, image
            ));
        }
        if !sampler_loads.iter().any(|(_, id)| id == sampler_value) {
            return Err(format!(
                "the OpSampledImage at {} uses sampler {}, which is not a load of the \
                 sampler variable",
                insns[*index].at, sampler_value
            ));
        }
    }

    // A loaded texture or sampler may be read only by an `OpSampledImage`.
    let sample_insns: Vec<usize> = sample_sites.iter().map(|(index, ..)| *index).collect();
    for (index, insn) in insns.iter().enumerate() {
        if sample_insns.contains(&index) || insn.op == OP_LOAD {
            continue;
        }
        for value in ids_of(insn, words)? {
            let loaded = texture_loads.iter().any(|(_, id)| *id == value)
                || sampler_loads.iter().any(|(_, id)| *id == value);
            if loaded {
                return Err(format!(
                    "a loaded texture or sampler is read outside an OpSampledImage \
                     (opcode {}), which this transform does not model",
                    insn.op
                ));
            }
        }
    }

    // What each removed id becomes. An `OpSampledImage` disappears, and every
    // reader of its result reads the texture load's result instead.
    let mut replacements: std::collections::HashMap<u32, u32> = std::collections::HashMap::new();
    for (_, result, image, _) in &sample_sites {
        replacements.insert(*result, *image);
    }

    // ── rebuild ───────────────────────────────────────────────────────────
    //
    // The module already has an `OpTypeSampledImage` for this image — naga emits
    // one at every sample site — and reusing it keeps SPIR-V's "no duplicate
    // non-aggregate types" rule. Only the pointer type is new.
    let bound = words[BOUND_WORD];
    let combined_type = bound;
    let combined_ptr = bound + 1;
    let stale = stale_sampled_images(&insns, words, texture.pointee_type);

    let texture_load_insns: Vec<usize> = texture_loads.iter().map(|(index, _)| *index).collect();
    let sampler_load_insns: Vec<usize> = sampler_loads.iter().map(|(index, _)| *index).collect();

    let mut out: Vec<u32> = words[..HEADER_WORDS].to_vec();
    out[BOUND_WORD] = combined_ptr + 1;

    for (index, insn) in insns.iter().enumerate() {
        let ops = insn.operands(words);
        if index == sampler.decl
            || sampler_load_insns.contains(&index)
            || sample_insns.contains(&index)
            || stale.contains(&index)
        {
            continue;
        }
        if (insn.op == OP_DECORATE || insn.op == OP_NAME)
            && !ops.is_empty()
            && ops[0] == sampler.var_id
        {
            continue; // decorations naming the removed variable
        }
        if index == texture.decl {
            // Re-type the texture variable to point at the combined image.
            out.push((insn.wc as u32) << 16 | insn.op as u32);
            out.push(combined_ptr);
            out.extend_from_slice(&ops[1..]);
            continue;
        }
        if texture_load_insns.contains(&index) {
            // Each load now produces the combined sampled image.
            out.push((insn.wc as u32) << 16 | insn.op as u32);
            out.push(combined_type);
            out.extend_from_slice(&ops[1..]);
            continue;
        }
        // Everything else is copied, with readers of a folded OpSampledImage
        // redirected to the texture load that fed it.
        let (positions, tail) = id_operands(insn.op).ok_or_else(|| {
            format!("opcode {} is not one this transform understands", insn.op)
        })?;
        let mut rebuilt: Vec<u32> = Vec::with_capacity(insn.wc);
        rebuilt.push((insn.wc as u32) << 16 | insn.op as u32);
        let tail_from = positions.last().copied().unwrap_or(0) + 1;
        for (at, value) in ops.iter().enumerate() {
            let is_id = positions.contains(&at) || (tail && at >= tail_from);
            if is_id {
                if let Some(replacement) = replacements.get(value) {
                    rebuilt.push(*replacement);
                    continue;
                }
            }
            rebuilt.push(*value);
        }
        out.extend_from_slice(&rebuilt);

        // The two new type instructions go right after the sampler type, which
        // is the last thing they depend on.
        if insn.op == OP_TYPE_SAMPLER {
            out.push(3 << 16 | OP_TYPE_SAMPLED_IMAGE as u32);
            out.push(combined_type);
            out.push(texture.pointee_type);
            out.push(4 << 16 | OP_TYPE_POINTER as u32);
            out.push(combined_ptr);
            out.push(STORAGE_UNIFORM_CONSTANT);
            out.push(combined_type);
        }
    }

    // ── post-condition: the removed ids are gone, everywhere ──────────────
    let mut gone: Vec<u32> = vec![sampler.var_id];
    gone.extend(sampler_loads.iter().map(|(_, id)| *id));
    gone.extend(sample_sites.iter().map(|(_, result, ..)| *result));
    for id in gone {
        if out.contains(&id) {
            return Err(format!(
                "id {id} survived the rewrite; the analysis missed a use"
            ));
        }
    }
    *words = out;
    Ok(true)
}

/// The pair exists but the texture is never read: drop the sampler and re-type
/// the texture, so the single remaining binding is the combined one SDL declares.
fn fold_unused_texture(
    words: &mut Vec<u32>,
    insns: &[Insn],
    texture: SamplerVar,
    sampler: SamplerVar,
) -> std::result::Result<bool, String> {
    for insn in insns {
        if insn.op == OP_LOAD {
            let ops = insn.operands(words);
            if ops.len() >= 3 && (ops[2] == texture.var_id || ops[2] == sampler.var_id) {
                return Err(
                    "the texture is loaded but no OpSampledImage combines it; this transform \
                     does not model that shape"
                        .to_string(),
                );
            }
        }
    }

    let bound = words[BOUND_WORD];
    let combined_type = bound;
    let combined_ptr = bound + 1;
    let stale = stale_sampled_images(insns, words, texture.pointee_type);
    let mut out: Vec<u32> = words[..HEADER_WORDS].to_vec();
    out[BOUND_WORD] = combined_ptr + 1;
    for insn in insns {
        let ops = insn.operands(words);
        if insn.op == OP_VARIABLE && !ops.is_empty() && ops[1] == sampler.var_id {
            continue;
        }
        if (insn.op == OP_DECORATE || insn.op == OP_NAME)
            && !ops.is_empty()
            && ops[0] == sampler.var_id
        {
            continue;
        }
        if insn.op == OP_VARIABLE && !ops.is_empty() && ops[1] == texture.var_id {
            out.push((insn.wc as u32) << 16 | insn.op as u32);
            out.push(combined_ptr);
            out.extend_from_slice(&ops[1..]);
            continue;
        }
        out.extend_from_slice(&words[insn.at..insn.at + insn.wc]);
        if insn.op == OP_TYPE_SAMPLER {
            out.push(3 << 16 | OP_TYPE_SAMPLED_IMAGE as u32);
            out.push(combined_type);
            out.push(texture.pointee_type);
            out.push(4 << 16 | OP_TYPE_POINTER as u32);
            out.push(combined_ptr);
            out.push(STORAGE_UNIFORM_CONSTANT);
            out.push(combined_type);
        }
    }
    if out.contains(&sampler.var_id) {
        return Err(format!(
            "sampler variable {} survived the rewrite",
            sampler.var_id
        ));
    }
    *words = out;
    Ok(true)
}
